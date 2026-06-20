# Раздел 11. Обсервабилити (Observability) и Middleware

В .NET наблюдаемость — это во многом «батарейки в комплекте» от ASP.NET Core и хостинга: конвейер middleware подключается одним `app.UseMiddleware<T>()`, логирование живёт за `ILogger<T>` и DI, метрики и трейсинг строятся на `System.Diagnostics` (`Activity`, `Meter`), а провайдеры регистрируются в `IServiceCollection`. Многое включается само и настраивается конфигурацией.

В Go подход обратный — и узнаваемо «спартанский». Перехват запросов вы собираете руками из функций-декораторов (`func(http.Handler) http.Handler`), а не из встроенного конвейера. Зато с Go 1.21 структурное логирование стало частью стандартной библиотеки (`log/slog`), метрики снимаются официальным `prometheus/client_golang` по pull-модели, а распределённый трейсинг — это вендоронезависимый OpenTelemetry. Этот раздел показывает, как из этих кирпичей собрать три столпа наблюдаемости — **логи, метрики, трейсы** — и единый механизм их внедрения: декоратор.

## Цели обучения

После этого раздела вы будете:

- Понимать паттерн **Декоратор** как основу любого перехвата в Go и собирать цепочки HTTP-middleware (логирование → метрики → трейсинг → recover → бизнес), а также применять его к gRPC-интерсепторам и обёрткам вокруг БД/клиентов.
- Логировать структурно через встроенный `log/slog`: `Handler`, уровни, типизированные атрибуты, контекстные поля через `With`, проброс через `context` — и понимать, чем это отличается от `ILogger`/Serilog.
- Снимать метрики `prometheus/client_golang`: различать Counter, Gauge, Histogram, Summary, выставлять эндпоинт `/metrics` и осознанно управлять кардинальностью лейблов.
- Инструментировать сервис распределённым трейсингом на OpenTelemetry: создавать спаны, прокидывать контекст между сервисами через W3C Trace Context, экспортировать трейсы по OTLP.
- Переводить привычные примитивы наблюдаемости .NET (`Activity`/`ActivitySource`, `Meter`, `ILogger`, middleware pipeline) в их Go-аналоги.

## Содержание раздела

1. [Middleware и декораторы](./01-middleware-decorator.md) — паттерн Декоратор как механизм перехвата; цепочки HTTP-middleware, gRPC-интерсепторы, обёртки вокруг клиентов; «луковичная» модель против конвейера ASP.NET.
2. [Логирование: slog](./02-logging-slog.md) — эволюция от `logrus`/`zap`/`zerolog` к встроенному `log/slog`; `Logger`/`Handler`, уровни, типизированные атрибуты, `With`, `InfoContext`; структурное логирование против message templates.
3. [Метрики: Prometheus](./03-metrics-prometheus.md) — pull-модель, `client_golang`, эндпоинт `/metrics`; Counter/Gauge/Histogram/Summary, лейблы и кардинальность; параллель с `System.Diagnostics.Metrics`.
4. [Трейсинг: OpenTelemetry](./04-tracing-opentelemetry.md) — распределённый трейсинг, `Tracer`/`Span`/атрибуты/статус; контекст и пропагация (W3C Trace Context), OTLP-экспортёры; `Activity` как нативная основа трейсинга в .NET.
5. [Сравнение с .NET](./05-comparison-with-dotnet.md) — консолидированный мостик: pipeline против декораторов, `ILogger`/Serilog против `slog`, `Activity`/`Meter` против OpenTelemetry-Go и `client_golang`, сводная таблица примитивов.

## Ориентир: что в .NET → что в Go

Держите таблицу под рукой при чтении раздела. Детали каждого сопоставления разбираются в соответствующих главах.

| В .NET / C#                                        | В Go                                                       | Ключевое отличие                                                                 |
| -------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Middleware pipeline (`app.UseMiddleware<T>`)       | Цепочка декораторов `func(http.Handler) http.Handler`     | Встроенный конвейер хоста против ручной композиции функций                       |
| `RequestDelegate next` + `await next(context)`     | `next.ServeHTTP(w, r)` внутри обёртки                     | Тот же принцип «вызови следующего», но без рантайма хоста                        |
| gRPC interceptors (`Interceptor` базовый класс)    | `grpc.UnaryServerInterceptor` / `StreamServerInterceptor` | Функциональная сигнатура вместо наследования                                    |
| `ILogger` / `ILogger<T>` + провайдеры              | `*slog.Logger` + `slog.Handler`                           | Один интерфейс хендлера вместо набора провайдеров; structured by default         |
| Serilog (структурный логгер)                       | `log/slog` (встроен в stdlib с Go 1.21)                   | Структурность — в стандартной библиотеке, не сторонняя зависимость               |
| Message templates (`"User {UserId} ..."`)          | Пары ключ-значение (`"user_id", id`)                      | Нет шаблона-строки: ключи и значения передаются раздельно                       |
| Logging scopes (`BeginScope`)                      | `logger.With(...)` → новый `*Logger`                      | Контекст «прибит» к экземпляру логгера, а не к области стека                      |
| `System.Diagnostics.Metrics.Meter` / `Counter<T>` | `prometheus/client_golang` (Counter/Gauge/Histogram)      | `Meter` нейтрален к бэкенду; `client_golang` заточен под Prometheus              |
| prometheus-net                                      | `prometheus/client_golang`                                | Официальный клиент языка против сторонней библиотеки                             |
| Pull-модель (scrape `/metrics`)                    | Pull-модель (scrape `/metrics`)                           | **Совпадает**: Prometheus сам ходит за метриками                                 |
| `System.Diagnostics.Activity`                      | `trace.Span` (OpenTelemetry)                              | `Activity` — нативный тип рантайма; в Go span целиком из OTel                    |
| `ActivitySource`                                   | `trace.Tracer` (`otel.Tracer(name)`)                      | Фабрика спанов; в .NET встроена, в Go из библиотеки                              |
| OpenTelemetry .NET (поверх `Activity`)             | OpenTelemetry-Go (`go.opentelemetry.io/otel`)             | В .NET OTel — мост к `Activity`; в Go OTel — первичный API                       |
| W3C Trace Context (через `Activity`/headers)       | W3C Trace Context (`propagation.TraceContext`)            | **Совпадает**: один стандарт пропагации `traceparent`                            |

---

[⌂ Главная](../../README.md) · [→ Следующий: Middleware и декораторы](./01-middleware-decorator.md)
