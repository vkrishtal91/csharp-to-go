# Сравнение с .NET

Это итоговая глава раздела — консолидированный «мостик» между сетевым стеком .NET и Go. Мы собираем воедино то, что разбиралось в предыдущих главах, и проговариваем главное фундаментальное различие двух подходов: **«всё во фреймворке/SDK» против «явные кирпичики стандартной библиотеки плюс внешний тулинг»**.

Если свести раздел к одной мысли: в .NET сетевой слой — это **продукт** (ASP.NET Core + встроенный gRPC), где между вашим методом и сокетом лежит толстый слой инфраструктуры, который делает многое за вас, но непрозрачно. В Go сетевой слой — это **конструктор**, где вы сами видите и собираете каждый кусок: HTTP-сервер из `http.Handler` и `ServeMux`, middleware из функций, gRPC из явно сгенерированного кода. Многословнее — но видно всё.

## Фундаментальное различие: фреймворк против конструктора

### Как это устроено в .NET

ASP.NET Core — это интегрированный веб-фреймворк. Вы получаете единый, мощный конвейер, в котором заранее решены роутинг, биндинг модели, валидация, DI, фильтры, аутентификация, а gRPC встроен в сборку проекта. Цена — непрозрачность: чтобы понять, что происходит с запросом, нужно знать, как устроен фреймворк, потому что в коде вашего контроллера большей части этой механики не видно.

```csharp
// .NET: фреймворк делает роутинг, биндинг, валидацию, DI — почти всё неявно
app.MapGet("/items/{id}", async (int id, IItemRepo repo) =>
{
    var item = await repo.GetAsync(id);     // id уже распарсен в int (биндинг)
    return item is null ? Results.NotFound() // repo пришёл из DI-контейнера
                        : Results.Ok(item);
});
```

### Как это устроено в Go

В Go нет «веб-фреймворка по умолчанию» — есть стандартная библиотека `net/http` и набор примитивов, из которых вы собираете обработку сами. Биндинг, валидацию и доступ к зависимостям вы пишете явно. Это многословнее, но в коде обработчика видно **всё**, что происходит с запросом.

```go
// Go: всё явно — извлечение параметра, конвертация, зависимость через замыкание
func getItem(repo ItemRepo) http.HandlerFunc { // зависимость захвачена замыканием
    return func(w http.ResponseWriter, r *http.Request) {
        id, err := strconv.Atoi(r.PathValue("id")) // парсим сами (Go 1.22 wildcard)
        if err != nil {
            http.Error(w, "bad id", http.StatusBadRequest)
            return
        }
        item, err := repo.Get(r.Context(), id)
        if err != nil {
            http.Error(w, "not found", http.StatusNotFound)
            return
        }
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(item) // сериализуем сами
    }
}
```

> Это та же инверсия, что проходит через весь учебник. В .NET инфраструктуру предоставляет фреймворк — единообразно, но непрозрачно. В Go инфраструктуру вы собираете руками — многословно, но без «магии»: что в коде написано, то и выполняется.

## HTTP: ASP.NET Core против `net/http`

Сводно по основным аспектам обработки HTTP-запроса:

| Аспект | ASP.NET Core | Go (`net/http`) |
| --- | --- | --- |
| Сервер | Kestrel + хостинг (часть фреймворка) | `http.Server` из stdlib |
| Единица обработки | Controller action / Minimal API endpoint | `http.Handler` / `http.HandlerFunc` |
| Роутинг | атрибуты `[HttpGet("...")]` / `MapGet` | `mux.HandleFunc("GET /x/{id}", ...)` (Go 1.22) |
| Path-параметры | биндинг (`[FromRoute] int id`) | `r.PathValue("id")` + ручная конвертация |
| Тело запроса | биндинг в DTO + валидация автоматом | `json.NewDecoder(r.Body).Decode(&dto)` вручную |
| Сквозная логика | middleware pipeline (`app.Use`) + фильтры | `func(http.Handler) http.Handler` в цепочке |
| Зависимости | DI-контейнер (инъекция) | замыкание / поля структуры (явно) |
| Остановка | хостинг + `IHostApplicationLifetime` | `srv.Shutdown(ctx)` по сигналу ОС |
| HTTP-клиент | `HttpClient` (+ `IHttpClientFactory`) | `http.Client` (переиспользуемый) |

Главный вывод из таблицы: в ASP.NET Core правый набор задач (биндинг, валидация, DI, lifecycle) **решает фреймворк**, в Go каждую из них вы решаете **явным кодом**. Роутинг в Go 1.22 подтянулся к уровню фреймворка по выразительности паттернов, но биндинг и DI остаются на вас.

## gRPC: встроенный тулинг против `protoc`/Buf

| Аспект | grpc-dotnet | Go (grpc-go) |
| --- | --- | --- |
| Источник контракта | `.proto` (общий стандарт) | `.proto` (общий стандарт) — идентичен |
| Когда генерируется код | неявно, при `dotnet build` (`<Protobuf>`) | явной командой `protoc` / `buf generate` |
| Где живут артефакты | в `obj/` (обычно не в git) | `*.pb.go` коммитятся в git, видны в ревью |
| Реализация сервера | наследование `ServiceBase` | встраивание `Unimplemented...` (композиция) |
| Регистрация сервера | DI + `MapGrpcService<T>()` | `RegisterXServer(s, impl)` явно |
| Создание клиента | `GrpcChannel.ForAddress` / `AddGrpcClient` | `grpc.NewClient(...)` (не `grpc.Dial`) |
| Стриминг | `IAsyncEnumerable<T>` / `await foreach` | явные `Send`/`Recv` + `io.EOF` |
| Балансировка | `ServiceConfig` + resolver | `round_robin` JSON в `WithDefaultServiceConfig` |
| mTLS | Kestrel + `HttpClientHandler` | `credentials.NewTLS(&tls.Config{...})` |
| Перехват | `Interceptor` (DI) | interceptors + `ChainUnaryInterceptor` |
| Шаринг контрактов | NuGet-пакет (платформо-зависим) | Buf / BSR (язык-агностичен) |

Ключевые расхождения: (1) генерация кода в Go — **явный шаг**, а артефакты коммитятся; (2) стриминг **явный** (без сахара `IAsyncEnumerable`); (3) шаринг контрактов в Go тяготеет к язык-агностичному Buf/BSR вместо платформенного NuGet.

## Как сделать привычное X

Прикладные рецепты «было в .NET → стало в Go» для самых частых задач.

### Контроллер с экшеном → handler-функция

```csharp
// .NET
[ApiController]
[Route("items")]
public class ItemsController : ControllerBase
{
    [HttpGet("{id}")]
    public ActionResult<Item> Get(int id) => _repo.Get(id) is { } x ? Ok(x) : NotFound();
}
```

```go
// Go: функция-обработчик + регистрация в mux (Go 1.22)
func (h *ItemsHandler) Get(w http.ResponseWriter, r *http.Request) {
    id, _ := strconv.Atoi(r.PathValue("id"))
    item, err := h.repo.Get(r.Context(), id)
    if err != nil {
        http.Error(w, "not found", http.StatusNotFound)
        return
    }
    json.NewEncoder(w).Encode(item)
}

mux.HandleFunc("GET /items/{id}", h.Get)
```

Контроллер-класс с атрибутами превращается в обычную функцию (или метод структуры с зависимостями в полях), а роутинг выносится во внешнюю регистрацию в `ServeMux`.

### Middleware pipeline → цепочка обёрток

```csharp
// .NET: регистрация в конвейере, порядок = порядок вызова
app.UseAuthentication();
app.UseAuthorization();
app.Use(async (ctx, next) => { /* лог */ await next(); });
```

```go
// Go: обёртки func(http.Handler) http.Handler, порядок = порядок обёртывания
var h http.Handler = mux
h = loggingMiddleware(h) // внешний слой — отработает первым на входе
h = authMiddleware(h)
```

Конвейер `Use(...)` становится вложенными вызовами-обёртками; порядок выполнения так же определяется порядком регистрации. Зависимости middleware в Go захватываются замыканием, а не приходят из DI.

### gRPC-сервис → `.proto` + кодоген

```csharp
// .NET: добавить .proto в .csproj — и код появится на сборке
// <Protobuf Include="Protos\items.proto" GrpcServices="Server" />
public class ItemService : Items.ItemsBase
{
    public override Task<Item> GetItem(GetItemRequest req, ServerCallContext ctx) => ...;
}
```

```go
// Go: тот же .proto, но генерация — явный шаг (buf generate), затем встраивание
type itemServer struct {
    itemsv1.UnimplementedItemServiceServer
}
func (s *itemServer) GetItem(ctx context.Context, req *itemsv1.GetItemRequest) (*itemsv1.Item, error) { ... }
```

Сам `.proto` переносится между платформами один в один. Различие — в процессе: вместо неявной генерации на сборке вы запускаете `buf generate` и коммитите результат, а вместо наследования базового класса встраиваете `Unimplemented...`.

### DI-зарегистрированная зависимость → явная передача

```csharp
// .NET: контейнер сам внедрит IItemRepo
builder.Services.AddScoped<IItemRepo, SqlItemRepo>();
```

```go
// Go: собираете зависимости руками в main (composition root) и передаёте явно
repo := NewSqlItemRepo(db)
h := &ItemsHandler{repo: repo} // зависимость — поле структуры
mux.HandleFunc("GET /items/{id}", h.Get)
```

DI-контейнера в Go нет: граф зависимостей собирается вручную в одной точке (`main`) и передаётся через поля структур или замыкания. Подробнее про ручной DI — в [Разделе 5](../05-architecture-di-config/README.md).

## Когда что выбирать (честный взгляд)

Ни один подход не «лучше во всём» — это инженерный компромисс, как и в случае async/await против горутин из [Раздела 3](../03-concurrency/06-comparison-with-dotnet.md).

- **ASP.NET Core выигрывает** на скорости старта команды и широте «батареек»: биндинг, валидация, DI, аутентификация, OpenAPI, gRPC — всё интегрировано и работает из коробки. Для крупного приложения с богатой бизнес-логикой это огромная экономия.
- **`net/http` + явный тулинг выигрывают** на прозрачности и предсказуемости: нет скрытого слоя, который надо «знать»; меньше «магии» в рантайме; легче рассуждать о том, что именно делает код и сколько он аллоцирует. Стандартная библиотека стабильна годами и не тянет тяжёлых зависимостей.

Практический сухой остаток для переходящего с .NET:

- ✅ Не ищите «Go-аналог ASP.NET Core» как единый фреймворк — для HTTP стартуйте со stdlib (`net/http` + роутинг 1.22), добавляя `chi` только при реальной нужде.
- ✅ Примите явность как фичу: биндинг, валидацию и DI вы пишете руками, и это нормально.
- ✅ Для gRPC сразу берите **Buf** вместо голого `protoc`, а контракты шарьте через BSR, а не копированием.
- ❌ Не тащите в Go привычку прятать инфраструктуру: в Go ценность как раз в том, что путь запроса виден целиком.

## Итог

- Фундаментальное различие сетевого стека: .NET даёт **интегрированный фреймворк** (ASP.NET Core + встроенный gRPC), Go — **конструктор из примитивов** stdlib плюс внешний тулинг. Та же инверсия «магия фреймворка против явного кода», что и во всём учебнике.
- HTTP: в ASP.NET Core роутинг, биндинг, валидация, DI и lifecycle решает фреймворк; в Go каждую задачу вы пишете явно, а роутинг 1.22 закрывает выразительность паттернов.
- gRPC: контракт `.proto` идентичен, но в Go кодогенерация — явный шаг (артефакты в git), стриминг явный (`Send`/`Recv`), а шаринг контрактов язык-агностичен (Buf/BSR против NuGet).
- Рецепты переноса: контроллер → handler-функция; pipeline → цепочка обёрток; gRPC-сервис → `.proto` + `buf generate` + встраивание; DI → ручная сборка в `main`.
- Выбор — компромисс: ASP.NET Core быстрее стартует и богаче «батарейками»; `net/http` прозрачнее и предсказуемее. Переходя с .NET, примите явность Go как преимущество, а не как недостаток.

На этом раздел о сети, API и межсервисном взаимодействии завершён. Дальше — [Раздел 9](../09-resilience/README.md) про resilience-паттерны (ретраи, circuit breaker, rate limiting), которые в Go добавляют поверх этого сетевого слоя отдельными библиотеками.

---

[⌂ Главная](../../README.md) · [↑ Раздел](./README.md) · [← Предыдущий: Шаринг контрактов и Buf](./03-contract-sharing-buf.md)
