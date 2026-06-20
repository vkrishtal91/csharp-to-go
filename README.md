# От .NET к Go: Путеводитель для C#-разработчика

Переход с богатого абстракциями C# на спартанский Go — это не просто изучение нового синтаксиса. Это фундаментальный сдвиг в инженерном мышлении. Здесь мы отказываемся от «магии» фреймворков, тяжелых ORM и скрытых аллокаций ради предсказуемости, скорости и полного контроля.

Этот репозиторий — структурированный справочник для .NET-инженеров, которые хотят перенести свой Enterprise-опыт в мир Go, четко понимая разницу архитектур и внутреннее устройство языка.

---

## Оглавление учебника

> Все 14 разделов готовы. Каждый раздел — отдельная папка в `docs/` с индексом и главами. Кликайте по названию раздела (индекс) или по конкретной главе.

### [Раздел 1. Философия, Синтаксис и Структуры данных](docs/01-philosophy-and-syntax/README.md)

* Спартанский подход: 25 ключевых слов и встроенные функции (`builtin`).
* Семантика значений: почему в Go нет деления на value/reference типы и всё копируется по значению.
* Коллекции: массивы, слайсы, мапы. Реализация стека, очереди и `HashSet`.
* Слайсы под капотом: длина (`len`), вместимость (`cap`), аллокации.
* **Сравнение с .NET:** Богатый синтаксис C# против минимализма Go. Жизнь без LINQ. `List<T>` и `Dictionary<K,V>` против встроенных срезов и мап.

**Главы:** [Спартанский подход: ключевые слова и `builtin`](docs/01-philosophy-and-syntax/01-spartan-philosophy.md) · [Семантика значений](docs/01-philosophy-and-syntax/02-value-semantics.md) · [Коллекции](docs/01-philosophy-and-syntax/03-collections.md) · [Слайсы под капотом](docs/01-philosophy-and-syntax/04-slices-internals.md) · [Сравнение с .NET](docs/01-philosophy-and-syntax/05-comparison-with-dotnet.md)

### [Раздел 2. Память, GC и Система типов (Глубокое погружение)](docs/02-memory-gc-and-types/README.md)

* Стек vs Куча: как работает Escape Analysis.
* Указатели (`*` и `&`): передача по значению против передачи по ссылке.
* Отсутствие NRE: `nil pointer dereference` и работа методов с `nil`-указателями.
* Интерфейсы и Duck Typing: неявная реализация контрактов.
* Пустой интерфейс (`any`), проблема Боксинга и как спасают Дженерики (Go 1.18+).
* **Сравнение с .NET:** `struct`/`class` в C# против Escape Analysis. Generational GC (Stop-The-World) против Concurrent Mark and Sweep (Low Latency). Упаковка типов.

**Главы:** [Стек vs Куча и Escape Analysis](docs/02-memory-gc-and-types/01-stack-vs-heap-escape-analysis.md) · [Указатели](docs/02-memory-gc-and-types/02-pointers.md) · [Нулевые значения и методы на `nil`](docs/02-memory-gc-and-types/03-nil-and-methods.md) · [Интерфейсы и Duck Typing](docs/02-memory-gc-and-types/04-interfaces-and-duck-typing.md) · [`any`, Боксинг и Дженерики](docs/02-memory-gc-and-types/05-any-boxing-and-generics.md) · [GC в Go и сравнение с .NET](docs/02-memory-gc-and-types/06-gc-and-comparison-with-dotnet.md)

### [Раздел 3. Конкурентность и Синхронизация](docs/03-concurrency/README.md)

* Горутины vs Потоки ОС: планировщик M:P:G, вес стека.
* Каналы (`chan`): буферизованные/небуферизованные, Producer-Consumer.
* Управление потоком: `select`, таймауты и отмена через `context.Context`.
* Синхронизация: `sync.Mutex` и `sync.WaitGroup`. Проблема Goroutine Leaks.
* **Сравнение с .NET:** `async/await` и `Task` против горутин. TPL Dataflow против `chan`. `lock()` против `sync.Mutex`.

**Главы:** [Горутины и планировщик GMP](docs/03-concurrency/01-goroutines-and-scheduler.md) · [Каналы](docs/03-concurrency/02-channels.md) · [`select` и `context`](docs/03-concurrency/03-select-and-context.md) · [Синхронизация и утечки](docs/03-concurrency/04-sync-and-leaks.md) · [Жизненный цикл и закрытие ресурсов](docs/03-concurrency/05-goroutine-lifecycle-and-streams.md) · [Сравнение с .NET](docs/03-concurrency/06-comparison-with-dotnet.md)

### [Раздел 4. Структура проекта, Пакеты и Зависимости](docs/04-project-structure-packages/README.md)

* Миф об «официальном стандарте» и реальный Community Layout: `cmd/`, `internal/`, `pkg/`.
* Системы пакетов: экспорт через заглавную букву.
* Управление зависимостями: `go.mod` и `go.sum`. Запрет на циклические импорты (Cyclic Imports).
* **Сравнение с .NET:** Жизнь без `.sln` и `.csproj`. Модификаторы доступа (`public`/`private`) против регистра букв. NuGet против `go get`.

**Главы:** [Структура проекта](docs/04-project-structure-packages/01-project-layout.md) · [Пакеты и видимость](docs/04-project-structure-packages/02-packages-and-visibility.md) · [Зависимости и go-модули](docs/04-project-structure-packages/03-dependencies-go-modules.md) · [Сравнение с .NET](docs/04-project-structure-packages/04-comparison-with-dotnet.md)

### [Раздел 5. Архитектура, DI и Конфигурации](docs/05-architecture-di-config/README.md)

* Инверсия контроля (IoC): ручной DI (Composition Root).
* Конфигурации: философия `env`. Библиотеки: `cleanenv`, `viper`, `caarlos0/env`.
* Тэги структур (`Struct Tags`), рефлексия и Валидация (`validator`).
* **Сравнение с .NET:** `IServiceCollection` против ручной сборки. `IConfiguration` против переменных окружения.

**Главы:** [Внедрение зависимостей (DI)](docs/05-architecture-di-config/01-dependency-injection.md) · [Конфигурация](docs/05-architecture-di-config/02-configuration.md) · [Тэги, рефлексия, валидация](docs/05-architecture-di-config/03-struct-tags-reflection-validation.md) · [Сравнение с .NET](docs/05-architecture-di-config/04-comparison-with-dotnet.md)

### [Раздел 6. Сериализация: JSON, YAML и Бинарные форматы](docs/06-serialization/README.md)

* **JSON (`encoding/json`):** тэги, `omitempty`, `null`-значения, интерфейсы сериализации.
* **YAML (`gopkg.in/yaml.v3`):** парсинг сложных конфигураций.
* **Бинарная сериализация:** стандартный `encoding/gob` vs Protobuf.
* **Сравнение с .NET:** `System.Text.Json` против `encoding/json` (разница в производительности).

**Главы:** [JSON](docs/06-serialization/01-json.md) · [YAML](docs/06-serialization/02-yaml.md) · [Бинарные форматы: gob и Protobuf](docs/06-serialization/03-binary-formats.md) · [Сравнение с .NET](docs/06-serialization/04-comparison-with-dotnet.md)

### [Раздел 7. Кодогенерация как философия языка](docs/07-code-generation/README.md)

* Почему Go выбирает генерацию (Compile-time) вместо магии рефлексии (Runtime).
* Директива `//go:generate`. Инструменты: `stringer`, `mockery`, `protoc`.
* **Сравнение с .NET:** Source Generators и Reflection Emit против генерации текста в Go.

**Главы:** [Генерация vs рефлексия](docs/07-code-generation/01-philosophy-codegen-vs-reflection.md) · [`go:generate` и инструменты](docs/07-code-generation/02-go-generate-and-tools.md) · [Сравнение с .NET](docs/07-code-generation/03-comparison-with-dotnet.md)

### [Раздел 8. Сеть, API и Межсервисное взаимодействие](docs/08-networking-api-grpc/README.md)

* HTTP-сервер (`net/http`) из коробки: встроенный роутинг.
* gRPC и Protobuf: написание контрактов, Client-side балансировка (Round Robin), mTLS.
* Шаринг контрактов в монорепозитории и через инструмент Buf.
* **Сравнение с .NET:** ASP.NET Core Controllers против `http.Handler`. Встроенный gRPC против `protoc`/Buf.

**Главы:** [HTTP-сервер (net/http)](docs/08-networking-api-grpc/01-http-server.md) · [gRPC и Protobuf](docs/08-networking-api-grpc/02-grpc-protobuf.md) · [Шаринг контрактов и Buf](docs/08-networking-api-grpc/03-contract-sharing-buf.md) · [Сравнение с .NET](docs/08-networking-api-grpc/04-comparison-with-dotnet.md)

### [Раздел 9. Resilience паттерны (Отказоустойчивость)](docs/09-resilience/README.md)

* Ретраи (Retries): встроенные циклы vs `avast/retry-go` (Exponential Backoff, Jitter).
* Circuit Breaker: паттерн предохранителя и `sony/gobreaker`.
* Rate Limiter: встроенный `golang.org/x/time/rate` и Token Bucket.
* **Сравнение с .NET:** Экосистема Polly против модульного подхода в Go.

**Главы:** [Ретраи](docs/09-resilience/01-retries.md) · [Circuit Breaker](docs/09-resilience/02-circuit-breaker.md) · [Rate Limiting](docs/09-resilience/03-rate-limiting.md) · [Сравнение с .NET](docs/09-resilience/04-comparison-with-dotnet.md)

### [Раздел 10. Работа с Данными](docs/10-data-access/README.md)

* Реляционные БД: `database/sql`, Connection Pool.
* `sqlx`: избавление от рутины через тэги `db`.
* Redis (`go-redis`) и паттерн Cache-Aside.
* **Сравнение с .NET:** EF Core и Dapper против голого SQL и `sqlx`. Управление пулом (ADO.NET vs `sql.DB`).

**Главы:** [`database/sql` и пул соединений](docs/10-data-access/01-database-sql.md) · [`sqlx`](docs/10-data-access/02-sqlx.md) · [Redis и Cache-Aside](docs/10-data-access/03-redis-cache-aside.md) · [Сравнение с .NET](docs/10-data-access/04-comparison-with-dotnet.md)

### [Раздел 11. Обсервабилити (Observability) и Middleware](docs/11-observability-middleware/README.md)

* Паттерн Декоратор: перехват запросов (HTTP, gRPC, БД).
* Логирование: эволюция от `zap` к встроенному `log/slog`.
* Метрики: Prometheus из коробки (Pull-модель, `/metrics`).
* Трейсинг: OpenTelemetry, прокидывание `TraceID`.
* **Сравнение с .NET:** ASP.NET Pipeline против Декораторов. Serilog против `slog`. `Activity` против `span`.

**Главы:** [Middleware и декораторы](docs/11-observability-middleware/01-middleware-decorator.md) · [Логирование: slog](docs/11-observability-middleware/02-logging-slog.md) · [Метрики: Prometheus](docs/11-observability-middleware/03-metrics-prometheus.md) · [Трейсинг: OpenTelemetry](docs/11-observability-middleware/04-tracing-opentelemetry.md) · [Сравнение с .NET](docs/11-observability-middleware/05-comparison-with-dotnet.md)

### [Раздел 12. Развертывание, Docker и Инфраструктура](docs/12-deployment-docker/README.md)

* Эффективный Docker-образ: Multi-stage сборка, сталинковка бинарников, образы `alpine` и `scratch` (15 МБ).
* Игнор-файлы: что класть в `.gitignore` и `.dockerignore`.
* **Сравнение с .NET:** ASP.NET Runtime Images против бинарника без ОС. JIT против AOT.

**Главы:** [Эффективный Docker-образ](docs/12-deployment-docker/01-docker-image.md) · [Игнор-файлы](docs/12-deployment-docker/02-ignore-files.md) · [Сравнение с .NET](docs/12-deployment-docker/03-comparison-with-dotnet.md)

### [Раздел 13. Тулинг: Управление, Отладка и Профилирование](docs/13-tooling-debug-profiling/README.md)

* Пакетный менеджер: `go get` vs `go install`.
* Отладка: стандарт Delve (`dlv`).
* Профилирование (`pprof`): поиск утечек памяти и CPU flame graphs на проде.
* **Сравнение с .NET:** .NET CLI против Go CLI. Visual Studio Profiler/dotTrace против `pprof`.

**Главы:** [Управление пакетами и инструментами](docs/13-tooling-debug-profiling/01-package-management.md) · [Отладка: Delve](docs/13-tooling-debug-profiling/02-debugging-delve.md) · [Профилирование: pprof](docs/13-tooling-debug-profiling/03-profiling-pprof.md) · [Сравнение с .NET](docs/13-tooling-debug-profiling/04-comparison-with-dotnet.md)

### [Раздел 14. Обработка ошибок и Тестирование](docs/14-errors-testing/README.md)

* Философия ошибок: `if err != nil`, `fmt.Errorf`, `errors.Is` / `errors.As`.
* Тестирование: встроенный `testing`. Table-driven tests.
* Моки (Mockery) и Testcontainers.
* **Сравнение с .NET:** Исключения (`try/catch/finally`) против возврата значений. xUnit/Moq против `testing` и кодогенерации моков.

**Главы:** [Обработка ошибок](docs/14-errors-testing/01-error-handling.md) · [defer, panic и recover](docs/14-errors-testing/02-defer-panic-recover.md) · [Тестирование](docs/14-errors-testing/03-testing.md) · [Моки и Testcontainers](docs/14-errors-testing/04-mocks-testcontainers.md) · [Сравнение с .NET](docs/14-errors-testing/05-comparison-with-dotnet.md)

---

*Материалы будут дополняться. Если вы нашли ошибку или хотите дополнить руководство — Pull Requests приветствуются!*
