# Сравнение с .NET

Предыдущие четыре главы вводили инструменты наблюдаемости Go по одному, постоянно сверяясь с .NET. Эта глава — консолидированный мостик: собираем все сопоставления в одном месте, проговариваем плюсы и минусы каждого подхода и завершаем сводной таблицей примитивов. Если предыдущие главы — про «как», то эта — про «чем это отличается от привычного и какой ценой».

Сквозная мысль раздела: .NET даёт наблюдаемость как **встроенную инфраструктуру** (конвейер хоста, DI, нативный `Activity` в рантайме) — много включается само и настраивается конфигурацией. Go даёт **кирпичи** (функции-декораторы, `slog`, `client_golang`, OpenTelemetry), которые вы складываете руками в composition root. Больше явности и контроля — больше ручной сборки и дисциплины.

## Middleware pipeline против декораторов

В .NET перехват запроса — встроенный конвейер middleware. Вы регистрируете компоненты на `IApplicationBuilder`, а хост сшивает их в «луковицу»:

```csharp
app.UseExceptionHandler("/error");  // recover
app.UseSerilogRequestLogging();     // лог
app.UseAuthentication();            // ...
app.MapControllers();               // бизнес
```

В Go нет конвейера — есть паттерн **Декоратор**: функции `func(http.Handler) http.Handler`, которые вы складываете сами (через хелпер `Chain` из главы 1):

```go
handler := Chain(mux,
    RecoverMiddleware,  // recover (снаружи)
    LoggingMiddleware,  // лог
    MetricsMiddleware,  // метрики
    TracingMiddleware,  // трейс (внутри, ближе к бизнесу)
)
```

| Аспект                 | ASP.NET pipeline                                 | Go-декораторы                                  |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Механизм               | встроенный конвейер хоста                         | ручная композиция функций                       |
| Регистрация            | `app.UseMiddleware<T>()` на `IApplicationBuilder` | `Chain(h, mw1, mw2, ...)` своими руками         |
| «Следующий»            | `RequestDelegate next` → `await next(context)`    | `next http.Handler` → `next.ServeHTTP(w, r)`    |
| Доступ к данным запроса | богатый `HttpContext` (статус, items, user)      | узкий `ResponseWriter` — оборачивают для статуса |
| Зависимости            | через DI в конструктор middleware                 | через замыкание-фабрику `mw(deps)`              |
| gRPC                   | классы-наследники `Interceptor`                   | функции `grpc.UnaryServerInterceptor`           |

**Плюсы .NET:** меньше шаблонного кода, единый порядок задаётся декларативно, DI и богатый `HttpContext` из коробки, готовая экосистема middleware. **Минусы:** порядок неявен (легко перепутать местами `Use...`), магия хоста скрывает, что происходит, сложнее собрать разные цепочки для разных групп маршрутов без специального API.

**Плюсы Go:** цепочка — обычное значение `http.Handler`, которое можно собирать как угодно и переиспользовать; всё видно глазами, никакой магии; один паттерн (декоратор) покрывает HTTP, gRPC и обёртки вокруг БД/клиентов. **Минусы:** больше ручного кода, `ResponseWriter` приходится оборачивать ради статуса/размера, порядок и корректность цепочки — на вас.

## `ILogger`/Serilog против `slog`

И там, и там итог — **структурированный лог** с именованными полями. Разница в эргономике и в том, откуда берётся реализация.

```csharp
// .NET: message template, поля извлекаются из {плейсхолдеров}
logger.LogInformation("Order {OrderId} placed by {UserId}", orderId, userId);
using (logger.BeginScope(new Dictionary<string,object> {["RequestId"]=id}))
{
    logger.LogInformation("validated"); // RequestId добавится из scope
}
```

```go
// Go: ключи и значения раздельно; контекст — через производный логгер
log := slog.With("request_id", id) // прибили поле к экземпляру логгера
log.Info("order placed", "order_id", orderID, "user_id", userID)
log.Info("validated") // request_id уже в каждой записи
```

| Аспект                 | .NET (`ILogger`/Serilog)                          | Go (`log/slog`)                                |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Происхождение          | абстракция MS + сторонний Serilog                 | встроено в stdlib (Go 1.21)                     |
| Формат вызова          | message template (`"{UserId}"`)                  | пары ключ-значение (`"user_id", id`)            |
| Структурность          | да (Serilog/структурные провайдеры)               | да, by default                                  |
| Бэкенд                 | несколько провайдеров на один `ILogger` (DI)      | один `Handler` на `Logger` (multi — отдельно)   |
| Контекстные поля       | `BeginScope` (область стека, `IDisposable`)        | `With` (привязка к экземпляру логгера)           |
| Типизированные поля    | аргументы шаблона / Serilog                        | `slog.String/Int64/...`, `LogAttrs` (zero-box)  |
| Связь с трейсингом     | enricher читает `Activity.Current` (неявно)        | хендлер читает `trace_id` из `ctx` (явно)        |

Ключевой нюанс — **контекстные поля**. `BeginScope` живёт в области стека (`using`) и снимается на выходе из блока; `slog.With` возвращает новый логгер-значение, и поля живут, пока вы держите этот логгер. Это та же разница «область кода против явного значения», что между `AsyncLocal` и `context.Context`. И связь с трейсингом: в .NET `trace_id` подмешивает enricher из ambient `Activity.Current`, в Go — хендлер из явно проброшенного `ctx`.

> **Параллель с .NET:** самый точный аналог `slog.With` — это `Serilog`-овский `logger.ForContext("RequestId", id)`, тоже возвращающий новый `ILogger`. А `slog.Handler` ближе всего к Serilog `Sink` / `ILoggerProvider`.

## `Activity`/`ActivitySource` против span/Tracer

Самое глубокое отличие модели наблюдаемости — в трейсинге. В .NET он **нативен**: `System.Diagnostics.Activity` и `ActivitySource` — типы рантайма (BCL), а ASP.NET Core и `HttpClient` создают `Activity` сами. OpenTelemetry .NET лишь **слушает** эти `Activity` (`ActivityListener`) и экспортирует их — то есть OTel здесь мост поверх уже существующего рантайм-трейсинга.

```csharp
// .NET: работаем с нативным Activity; про OTel можно даже не знать
private static readonly ActivitySource Source = new("myapp/checkout");

using var activity = Source.StartActivity("Checkout"); // родитель — Activity.Current (неявно)
activity?.SetTag("order.id", orderId);
activity?.SetStatus(ActivityStatusCode.Error, "failed");
```

```go
// Go: span целиком из OpenTelemetry; родитель — из ctx (явно)
var tracer = otel.Tracer("myapp/checkout")

ctx, span := tracer.Start(ctx, "Checkout")
defer span.End()
span.SetAttributes(attribute.Int64("order.id", orderID))
span.SetStatus(codes.Error, "failed")
```

| Аспект                 | .NET                                              | Go (OpenTelemetry)                             |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Тип спана              | `Activity` (нативный, в рантайме)                 | `trace.Span` (из OTel)                          |
| Фабрика                | `ActivitySource`                                 | `trace.Tracer` (`otel.Tracer(name)`)            |
| Роль OTel              | мост поверх `Activity` (`ActivityListener`)        | первичный и единственный API                    |
| Родитель спана         | `Activity.Current` (неявно, `AsyncLocal`)         | спан в `context.Context` (явно)                 |
| Завершение             | `activity.Dispose()` (`using`)                    | `span.End()` (`defer`)                          |
| Авто-инструментация    | встроена в ASP.NET/`HttpClient`                   | явные обёртки `otelhttp`/`otelgrpc`            |
| Пропагация             | W3C `traceparent` (нативно)                        | W3C `traceparent` (`propagation.TraceContext`)  |

Практический вывод для переходящего: в .NET вы могли инструментировать код одним `ActivitySource`, не думая про OTel и про проброс контекста (всё неявно). В Go вы с первой строки работаете напрямую с OpenTelemetry и **обязаны** пробрасывать `ctx`, иначе дерево спанов рассыпается. Зато пропагация (`traceparent`) — общий стандарт, поэтому Go- и .NET-сервисы трассируются сквозь языки в одном трейсе.

## Метрики: `System.Diagnostics.Metrics` против `client_golang`

Здесь моделей различий меньше всего — обе строятся вокруг тех же типов инструментов, и pull-модель Prometheus у обеих совпадает.

```csharp
// .NET
static readonly Meter Meter = new("myapp");
static readonly Counter<long> Requests = Meter.CreateCounter<long>("myapp_requests_total");
static readonly Histogram<double> Duration = Meter.CreateHistogram<double>("myapp_request_duration_seconds");

Requests.Add(1, new KeyValuePair<string,object?>("method", "GET"));
Duration.Record(elapsed.TotalSeconds, new("method", "GET"));
```

```go
// Go
var requests = promauto.NewCounterVec(prometheus.CounterOpts{Name: "myapp_requests_total"}, []string{"method"})
var duration = promauto.NewHistogramVec(prometheus.HistogramOpts{Name: "myapp_request_duration_seconds", Buckets: prometheus.DefBuckets}, []string{"method"})

requests.WithLabelValues("GET").Inc()
duration.WithLabelValues("GET").Observe(elapsed.Seconds())
```

| Аспект                 | .NET (`System.Diagnostics.Metrics`)               | Go (`client_golang`)                           |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Фабрика инструментов   | `Meter`                                          | `Registry` (+ `promauto`)                       |
| Нейтральность к бэкенду | да — `Meter` агностичен, экспортёр отдельно        | заточен под Prometheus                          |
| Счётчик                | `Counter<T>` (`.Add`)                             | `Counter` (`.Inc`/`.Add`)                       |
| Мгновенное значение    | `ObservableGauge<T>` / `UpDownCounter<T>`         | `Gauge` (`.Set`/`.Inc`/`.Dec`)                  |
| Распределение          | `Histogram<T>` (`.Record`)                        | `Histogram` (`.Observe`)                        |
| Лейблы/теги            | tags (`KeyValuePair`)                             | labels (`WithLabelValues`)                      |
| Кардинальность         | риск есть; есть отсев через `View`                | риск есть; дисциплину держите сами              |
| Эндпоинт `/metrics`    | prometheus-net / OTel-Prometheus экспортёр         | `promhttp.Handler()`                            |
| Модель сбора           | pull (scrape)                                     | pull (scrape) — **совпадает**                   |

Главное концептуальное различие: `Meter` в .NET **нейтрален к бэкенду** — те же инструменты можно экспортировать в Prometheus, OTLP, Application Insights, меняя только экспортёр. `client_golang` изначально заточен под Prometheus (если нужен OTLP-push для метрик из Go, берут OpenTelemetry-метрики вместо `client_golang`). А вот опасность **кардинальности** лейблов/тегов одинакова в обоих мирах и не зависит от языка.

## Сводная таблица примитивов наблюдаемости

Полная карта раздела — держите как шпаргалку при переносе наблюдаемости с .NET на Go.

| Примитив / задача             | .NET / C#                                          | Go                                                  | Ключевое отличие                                                |
| ----------------------------- | ------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Перехват HTTP-запроса         | middleware pipeline (`UseMiddleware<T>`)           | декоратор `func(http.Handler) http.Handler`         | встроенный конвейер против ручной композиции                    |
| «Следующий» в цепочке         | `await next(context)`                              | `next.ServeHTTP(w, r)`                              | тот же принцип, без рантайма хоста                              |
| Перехват gRPC                 | `Interceptor` (наследование)                       | `grpc.UnaryServerInterceptor` (функция)             | функция вместо базового класса                                 |
| Обработка паник/исключений    | `UseExceptionHandler` + `try/catch`                | recover-middleware + `defer`/`recover`              | исключения против паник; ошибки в Go — значения                |
| Перехват исходящих HTTP       | `DelegatingHandler` (`HttpClientFactory`)          | `http.RoundTripper` (обёртка `Transport`)           | оба оборачивают «следующий» транспорт                          |
| Логгер                        | `ILogger` / `ILogger<T>`                           | `*slog.Logger`                                      | один хендлер на логгер vs много провайдеров                    |
| Структурный бэкенд логов      | Serilog (`Sink`) / провайдеры                       | `slog.Handler` (`JSON`/`Text`)                      | в Go структурность — в stdlib                                  |
| Формат записи лога            | message template (`"{UserId}"`)                    | пары ключ-значение (`"user_id", id`)                | шаблон-строка против раздельных ключей                        |
| Контекстные поля лога         | `BeginScope` / `ForContext`                         | `logger.With(...)`                                 | область стека vs привязка к экземпляру                         |
| Лог с контекстом              | enricher из `Activity.Current` (неявно)            | `InfoContext(ctx, ...)` (явно)                      | ambient против явного `ctx`                                    |
| Метрика-счётчик               | `Counter<T>` (`Meter`)                             | `Counter` (`client_golang`)                         | `Meter` нейтрален к бэкенду                                    |
| Метрика-gauge                 | `ObservableGauge<T>` / `UpDownCounter<T>`           | `Gauge`                                             | —                                                              |
| Метрика-гистограмма           | `Histogram<T>`                                      | `Histogram` (`Observe`)                             | —                                                              |
| Эндпоинт метрик               | prometheus-net / OTel экспортёр                     | `promhttp.Handler()` на `/metrics`                  | pull-модель совпадает                                          |
| Span (единица трейса)         | `Activity` (нативный тип BCL)                       | `trace.Span` (из OTel)                              | нативный рантайм vs целиком OTel                               |
| Фабрика спанов                | `ActivitySource`                                   | `trace.Tracer` (`otel.Tracer`)                      | встроена vs из библиотеки                                      |
| Родитель спана                | `Activity.Current` (`AsyncLocal`, неявно)          | спан в `context.Context` (явно)                     | ambient против явного `ctx`                                    |
| Роль OpenTelemetry            | мост поверх `Activity`                              | первичный API трейсинга                             | надстройка vs основа                                          |
| Пропагация между сервисами    | W3C `traceparent` (нативно в `Activity`)           | W3C `traceparent` (`propagation.TraceContext`)      | один стандарт — трейс сквозь языки                            |
| Экспорт трейсов               | `.AddOtlpExporter()`                                | `otlptracegrpc`/`otlptracehttp` + `TracerProvider`  | OTLP по обе стороны                                            |
| Связь трёх столпов            | общий `Activity.Current` / `AsyncLocal`            | общий `context.Context`                             | в Go всё держится на проброшенном `ctx`                        |

## Итог

- **Философия**: .NET даёт наблюдаемость как встроенную инфраструктуру (конвейер хоста, DI, нативный `Activity`), Go — как кирпичи, складываемые руками. Больше явности и контроля ценой большего объёма ручной сборки.
- **Middleware**: ASP.NET pipeline против паттерна Декоратор. В Go один приём (`func(http.Handler) http.Handler`) покрывает HTTP, gRPC и обёртки вокруг БД/клиентов; цепочка — обычное значение, но статус ответа приходится перехватывать обёрткой `ResponseWriter`.
- **Логи**: `ILogger`/Serilog против встроенного `slog`. Итог одинаков (структурный лог), но `slog` передаёт ключи раздельно (не шаблоном), `With` привязывает поля к экземпляру логгера (не к области стека), а связь с трейсингом — через явный `ctx`, а не ambient `Activity.Current`.
- **Трейсинг** — самое большое отличие модели: в .NET span нативен (`Activity` в рантайме, OTel — мост поверх), в Go span целиком из OpenTelemetry, а родитель и весь трейс держатся на **явно проброшенном `ctx`**. Стандарт пропагации `traceparent` общий — сервисы трассируются сквозь языки.
- **Метрики**: различий меньше всего — те же типы инструментов и одинаковая pull-модель Prometheus. `Meter` нейтрален к бэкенду, `client_golang` заточен под Prometheus; опасность кардинальности лейблов одинакова везде.
- **Связующая нить Go** — `context.Context`: он переносит дедлайны/отмену (Раздел 3), контекст логов (`InfoContext`), родителя спана и `trace_id` для сшивки логов с трейсами. Где в .NET работает неявный ambient-контекст, в Go работает один явно передаваемый аргумент.

На этом раздел о наблюдаемости и middleware завершён. Вы понимаете паттерн Декоратор как основу перехвата, три столпа наблюдаемости (`slog`, Prometheus, OpenTelemetry) и то, как они ложатся на привычную инфраструктуру .NET — и, что важнее, чем принципиально отличаются.

---

[⌂ Главная](../../README.md) · [↑ Раздел](./README.md) · [← Предыдущий: Трейсинг: OpenTelemetry](./04-tracing-opentelemetry.md)
