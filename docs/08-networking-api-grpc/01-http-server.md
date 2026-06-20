# HTTP-сервер (net/http)

В .NET путь к HTTP-серверу проходит через фреймворк: вы создаёте `WebApplication`, под капотом поднимается Kestrel, а ваши endpoints описываются контроллерами или Minimal API. Сам сетевой слой почти не виден — он спрятан за хостингом ASP.NET Core.

В Go всё наоборот: HTTP-сервер промышленного качества — это часть **стандартной библиотеки** (`net/http`), а не сторонний фреймворк. Тот же `net/http` обслуживает огромные нагрузки в продакшене без какой-либо «надстройки». Платой за это идёт явность: вы своими руками собираете сервер из нескольких простых сущностей. Эта глава разбирает их по очереди — от одного обработчика до полноценного сервера с таймаутами и корректным остановом.

## Главная абстракция: интерфейс `http.Handler`

Всё в `net/http` крутится вокруг одного крошечного интерфейса:

```go
type Handler interface {
    ServeHTTP(w http.ResponseWriter, r *http.Request)
}
```

Любой тип, у которого есть метод `ServeHTTP(w, r)`, — это обработчик HTTP-запроса. `w http.ResponseWriter` — это «куда писать ответ» (заголовки, статус, тело), `r *http.Request` — входящий запрос (метод, URL, заголовки, тело). Никаких базовых классов, атрибутов или наследования — только этот интерфейс.

```go
type helloHandler struct{}

func (h helloHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/plain; charset=utf-8")
    w.WriteHeader(http.StatusOK)
    fmt.Fprintln(w, "Привет из Go")
}
```

> **Параллель с .NET:** ближайший по духу аналог `http.Handler` — это не контроллер, а низкоуровневый `RequestDelegate` (`Func<HttpContext, Task>`) из middleware-конвейера ASP.NET Core. Контроллер — это уже готовый, обвешанный инфраструктурой объект; `http.Handler` же — голый контракт «дай запрос, верни ответ», поверх которого вы строите всё остальное.

### `http.HandlerFunc`: функция как обработчик

Заводить структуру ради одного метода — избыточно. Стандартная библиотека даёт адаптер `http.HandlerFunc` — это тип-функция, у которого `ServeHTTP` просто вызывает саму функцию:

```go
// Определение в stdlib (для понимания механики):
type HandlerFunc func(http.ResponseWriter, *http.Request)
func (f HandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) { f(w, r) }
```

Это классический Go-приём: обычная функция нужной сигнатуры превращается в реализацию интерфейса приведением типа. Поэтому обработчик чаще всего пишут просто как функцию:

```go
func hello(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintln(w, "Привет из Go")
}

// http.HandlerFunc(hello) — это уже http.Handler
```

## Маршрутизация: `ServeMux`

`http.ServeMux` — это мультиплексор запросов (роутер из stdlib). Он сопоставляет путь запроса с зарегистрированным обработчиком. Создаётся через `http.NewServeMux()`:

```go
mux := http.NewServeMux()
mux.HandleFunc("/hello", hello)        // регистрируем функцию
mux.Handle("/health", helloHandler{})  // регистрируем http.Handler

http.ListenAndServe(":8080", mux) // mux сам реализует http.Handler
```

Обратите внимание: `mux` передаётся в `ListenAndServe` как обработчик — потому что `ServeMux` сам реализует `http.Handler`. Роутер здесь — это просто обработчик, который делегирует другим обработчикам. Композиция вместо магии.

### Роутинг до Go 1.22: почему брали сторонние роутеры

Исторически `ServeMux` был очень примитивным: он матчил **только путь**, не различал HTTP-методы и не умел извлекать переменные сегменты пути (`/items/{id}`). Чтобы получить `GET` vs `POST` на одном пути или вытащить `id` из URL, приходилось писать это руками внутри обработчика — либо брать сторонний роутер. Де-факто стандартами стали [`chi`](https://github.com/go-chi/chi) и [`gorilla/mux`](https://github.com/gorilla/mux):

```go
// Раньше: метод и path-параметры приходилось разруливать вручную
func items(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodGet { // stdlib не матчил по методу
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }
    // и id из пути выковыривали строковыми операциями...
}
```

### Роутинг в Go 1.22: метод и wildcards в stdlib ✅

В **Go 1.22** `ServeMux` существенно прокачали — и для многих сервисов сторонний роутер стал не нужен. Теперь в паттерн можно зашить **HTTP-метод** и **wildcard-сегменты**:

```go
mux := http.NewServeMux()

// Метод прямо в паттерне
mux.HandleFunc("GET /items", listItems)
mux.HandleFunc("POST /items", createItem)

// Wildcard-сегмент {id} — извлекается через r.PathValue
mux.HandleFunc("GET /items/{id}", getItem)
mux.HandleFunc("DELETE /items/{id}", deleteItem)

// Wildcard "до конца пути" через {rest...}
mux.HandleFunc("GET /files/{path...}", serveFile)
```

Значение wildcard достаётся методом `r.PathValue("id")`:

```go
func getItem(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id") // "42" из GET /items/42
    fmt.Fprintf(w, "запрошен item %s\n", id)
}
```

Правила матчинга в 1.22 стали точными и предсказуемыми:

- Метод указывается в начале паттерна (`GET `, `POST `, ...). Паттерн без метода матчит **любой** метод. Паттерн на `GET` автоматически обслуживает и `HEAD`.
- Если путь подходит под паттерн, но метод не совпал, mux сам вернёт `405 Method Not Allowed` (раньше это писали руками).
- При конкуренции паттернов выигрывает **более конкретный** (точный сегмент важнее wildcard); неоднозначные регистрации вызывают панику при старте — ошибку видно сразу, а не в рантайме.

> **Параллель с .NET:** `mux.HandleFunc("GET /items/{id}", ...)` — это прямой аналог `app.MapGet("/items/{id}", ...)` в Minimal API или атрибута `[HttpGet("items/{id}")]` на экшене контроллера. А `r.PathValue("id")` соответствует биндингу path-параметра (`[FromRoute] int id` или параметра метода `MapGet`). Принципиальная разница: в ASP.NET Core роутинг и **биндинг модели** (разбор `id` в `int`, тела в DTO, валидация) — часть фреймворка; в Go stdlib даёт вам только строку `r.PathValue("id")`, а конвертацию и декодирование тела (`json.NewDecoder(r.Body).Decode(&dto)`) вы пишете сами.

### Когда сторонний роутер всё ещё оправдан

Stdlib-роутинг 1.22 закрывает большинство REST-сценариев, но не всё. `chi` (как самый идиоматичный из живых роутеров) по-прежнему берут, когда нужны:

- группы маршрутов с общим префиксом и **scoped-middleware** на группу;
- удобные суброутеры (`r.Mount`/`r.Route`), регэксп-ограничения на параметры;
- большой набор готовых middleware «из коробки».

Важно, что `chi` сознательно совместим с `net/http`: его обработчики — те же `http.Handler`, поэтому миграция в обе стороны дешёвая. Для нового сервиса разумная тактика — начать со stdlib и подключить роутер, только когда упрётесь в его пределы.

## Middleware: `func(http.Handler) http.Handler`

Сквозная функциональность (логирование, аутентификация, recover от паник, CORS) в Go оформляется как **middleware** — функция, которая принимает обработчик и возвращает новый обработчик, оборачивающий исходный:

```go
type Middleware func(http.Handler) http.Handler
```

Внутри middleware вы делаете что-то «до», вызываете `next.ServeHTTP(w, r)` и, при желании, что-то «после»:

```go
func logging(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r) // передаём управление дальше по цепочке
        log.Printf("%s %s — %s", r.Method, r.URL.Path, time.Since(start))
    })
}
```

Несколько middleware складываются в **цепочку** обычной вложенностью вызовов:

```go
var handler http.Handler = mux
handler = logging(handler)        // внешний слой
handler = authMiddleware(handler) // ещё внешнее

http.ListenAndServe(":8080", handler)
```

Порядок обёртывания и есть порядок выполнения «на входе» — внешний middleware отрабатывает первым. Чтобы не плодить ручную вложенность, на практике пишут крошечный хелпер-«склейку» или используют `chi`, у которого цепочка задаётся декларативно (`r.Use(...)`). Сам путь запроса сквозь цепочку выглядит так:

```mermaid
flowchart LR
    REQ["HTTP-запрос"] --> LOG["logging<br/>(до: засекли время)"]
    LOG --> AUTH["auth<br/>(проверка токена)"]
    AUTH --> MUX["ServeMux<br/>(выбор маршрута)"]
    MUX --> H["обработчик<br/>getItem"]
    H -. "ответ идёт обратно" .-> AUTH
    AUTH -. .-> LOG
    LOG -. "(после: записали лог)" .-> RESP["HTTP-ответ"]
```

> **Параллель с .NET:** `func(http.Handler) http.Handler` — это в точности концепция middleware из конвейера ASP.NET Core (`app.Use(async (ctx, next) => { ... await next(); ... })`), где `next` играет роль следующего обработчика. Цепочка обёрток в Go = конвейер `Use(...)` в .NET, и порядок регистрации так же определяет порядок выполнения. Отличие в том, что в .NET middleware регистрируется в DI-контейнере и получает зависимости через инъекцию; в Go зависимости middleware «захватывает» замыканием (например, `func authMiddleware(secret string) Middleware { ... }`). Подробно про декораторы и обсервабилити — в [Разделе 11](../11-observability-middleware/README.md).

## Боевой `http.Server`: таймауты и graceful shutdown

`http.ListenAndServe(":8080", h)` хорош для примеров, но в проде так делать **нельзя**: у такого сервера нет таймаутов, и одно «медленное» соединение (slowloris-атака или просто залипший клиент) способно держать ресурсы бесконечно. Правильный путь — явно сконфигурировать `http.Server`.

### Таймауты ✅

```go
srv := &http.Server{
    Addr:              ":8080",
    Handler:           handler,
    ReadHeaderTimeout: 5 * time.Second,  // лимит на чтение заголовков (защита от slowloris)
    ReadTimeout:       15 * time.Second, // на чтение всего запроса (заголовки + тело)
    WriteTimeout:      15 * time.Second, // на запись ответа
    IdleTimeout:       60 * time.Second, // сколько держать keep-alive соединение простаивающим
}
log.Fatal(srv.ListenAndServe())
```

Что важно понимать:

- `ReadHeaderTimeout` — самый дешёвый и важный щит: без него заголовки можно слать по байту вечно.
- `ReadTimeout`/`WriteTimeout` ограничивают всю фазу чтения/записи. Для эндпоинтов со стримингом или загрузкой больших файлов их иногда ослабляют, перенося контроль на `context` запроса.
- `IdleTimeout` управляет временем жизни keep-alive соединений между запросами.

### Graceful shutdown через `srv.Shutdown(ctx)`

При деплое или остановке пода нельзя обрывать соединения на полуслове — нужно перестать принимать новые запросы и **дослужить** уже принятые. За это отвечает `srv.Shutdown(ctx)`: он закрывает слушающие сокеты и ждёт завершения активных запросов, но не дольше дедлайна из `context`.

```go
func main() {
    srv := &http.Server{Addr: ":8080", Handler: handler /* + таймауты */}

    // Запускаем сервер в отдельной горутине, чтобы main мог ждать сигнал.
    go func() {
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("ListenAndServe: %v", err)
        }
    }()

    // Ждём сигнал ОС об остановке (Ctrl+C, SIGTERM от Kubernetes).
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()
    <-ctx.Done() // блокируемся здесь до сигнала
    log.Println("останавливаемся...")

    // Даём 10 секунд на дослуживание текущих запросов.
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    if err := srv.Shutdown(shutdownCtx); err != nil {
        log.Printf("graceful shutdown не успел: %v", err)
    }
    log.Println("остановлено")
}
```

Ключевые детали:

- Нормально завершённый `Shutdown` приводит к тому, что `ListenAndServe` возвращает `http.ErrServerClosed` — это **не ошибка**, её специально отфильтровывают.
- `signal.NotifyContext` (Go 1.16+) — идиоматичный способ превратить сигнал ОС в отменяемый `context`, без ручной возни с каналом `os.Signal`.
- Если запросы не уложились в дедлайн `shutdownCtx`, `Shutdown` вернёт ошибку, а соединения будут принудительно закрыты.

> **Параллель с .NET:** `srv.Shutdown(ctx)` соответствует graceful-остановке хоста ASP.NET Core, которую оркеструют `IHostApplicationLifetime` и `HostOptions.ShutdownTimeout` — там тоже по `SIGTERM` хост перестаёт принимать запросы и ждёт дослуживания текущих в пределах таймаута. Разница в явности: в Go вы сами ловите сигнал, сами создаёте `context` с дедлайном и сами вызываете `Shutdown`; в .NET этот жизненный цикл по большей части управляется хостингом, а вы лишь подписываетесь на события или настраиваете таймаут.

## Клиентская сторона: `http.Client`

`net/http` — это и сервер, и клиент. Для исходящих запросов есть `http.Client`. Две вещи, которые обязан знать выходец из .NET с его историей «socket exhaustion» вокруг `HttpClient`:

```go
// ❌ Плохо: дефолтный клиент без таймаута может зависнуть навсегда
resp, err := http.Get("https://api.example.com/items")

// ✅ Хорошо: переиспользуемый клиент с общим таймаутом
var apiClient = &http.Client{
    Timeout: 10 * time.Second, // лимит на ВЕСЬ запрос: соединение + ответ
}

func fetch(ctx context.Context, url string) (*http.Response, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, err
    }
    return apiClient.Do(req) // context даёт отмену/дедлайн на конкретный запрос
}
```

Два правила:

1. **Переиспользуйте один `http.Client`** (и его `Transport`) на всё приложение. Внутри `Transport` живёт пул TCP-соединений с keep-alive; создавать новый клиент на каждый запрос — значит не переиспользовать соединения. Это прямой аналог совета «не создавайте `HttpClient` в `using` на каждый вызов» в .NET.
2. **Задавайте таймаут.** Поле `Client.Timeout` ограничивает весь запрос целиком; для гранулярной отмены отдельного вызова используйте `http.NewRequestWithContext` с `context` (см. [`select` и `context`](../03-concurrency/03-select-and-context.md)). И не забывайте `defer resp.Body.Close()` — иначе соединение не вернётся в пул.

> **Параллель с .NET:** `http.Client` ≈ `HttpClient`, и совет «один экземпляр на приложение» здесь тот же. Роль `IHttpClientFactory` (управление временем жизни хендлеров, поллинг DNS, политики Polly) в Go явного аналога не имеет: пул соединений уже живёт в переиспользуемом `Transport`, а resilience-обвязку (ретраи, circuit breaker) добавляют отдельными библиотеками — об этом [Раздел 9](../09-resilience/README.md).

## Итог

- `net/http` — это полноценный HTTP-сервер и клиент **из стандартной библиотеки**, а не сторонний фреймворк. Сервер собирается из явных кирпичиков, без скрытого хостинга.
- Центральная абстракция — интерфейс `http.Handler` (`ServeHTTP(w, r)`); функцию делает обработчиком адаптер `http.HandlerFunc`. Роутер `ServeMux` — это тоже просто `http.Handler`, делегирующий другим.
- **Go 1.22** добавил в `ServeMux` метод и wildcards в паттернах (`GET /items/{id}`, `r.PathValue("id")`), закрыв большинство сценариев, ради которых раньше брали `chi`/`gorilla/mux`. Сторонний роутер нужен теперь в основном ради групп, scoped-middleware и готового набора обвязки.
- Middleware — это `func(http.Handler) http.Handler`; цепочки собираются вложенностью, порядок виден в коде. Зависимости захватываются замыканием, а не инъекцией.
- В проде всегда конфигурируйте `http.Server` с таймаутами (минимум `ReadHeaderTimeout`) и делайте graceful shutdown через `srv.Shutdown(ctx)` по сигналу ОС; `http.ErrServerClosed` — это нормальный исход.
- На клиенте переиспользуйте один `http.Client` с таймаутом и `context`, закрывайте тело ответа.

Дальше — переходим от текстового HTTP к бинарному межсервисному взаимодействию: gRPC и Protobuf.

---

[⌂ Главная](../../README.md) · [↑ Раздел](./README.md) · [← Предыдущий: Обзор раздела](./README.md) · [→ Следующий: gRPC и Protobuf](./02-grpc-protobuf.md)
