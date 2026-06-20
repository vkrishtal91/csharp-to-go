# `database/sql` и пул соединений

Первое, что нужно усвоить .NET-разработчику: `database/sql` — это **не ORM и не клиент конкретной СУБД**. Это абстракция стандартной библиотеки над **драйверами** баз данных, ближайший аналог которой в .NET — не Entity Framework и даже не Dapper, а **ADO.NET**. `database/sql` определяет интерфейсы (`driver.Driver`, `driver.Conn` и т. п.) и поверх них даёт вам управление соединениями, транзакции, prepared statements и — самое важное — **пул соединений**. Сам же диалог с конкретной СУБД (бинарный протокол PostgreSQL, MySQL и т. д.) реализует драйвер, который вы подключаете отдельно.

```mermaid
flowchart TD
    APP["Ваш код"] --> SQL["database/sql<br/>(пул, транзакции, Scan-механика)"]
    SQL --> IFACE["интерфейсы driver.*"]
    IFACE --> D1["pgx/stdlib<br/>(PostgreSQL)"]
    IFACE --> D2["go-sql-driver/mysql<br/>(MySQL)"]
    IFACE --> D3["lib/pq<br/>(PostgreSQL, legacy)"]
    D1 --> PG[("PostgreSQL")]
    D2 --> MY[("MySQL")]
    D3 --> PG
```

> **Параллель с .NET:** в .NET связка «общий API + конкретный провайдер» — это `System.Data.Common` (`DbConnection`/`DbCommand`/`DbDataReader`) плюс провайдер вроде `Npgsql` или `Microsoft.Data.SqlClient`. В Go роль `System.Data.Common` играет `database/sql`, а роль провайдера — драйвер. Разница не в архитектуре (она почти идентична), а в уровне: в Go этот низкоуровневый слой — часть **стандартной библиотеки**, и идиоматичный Go-код очень часто живёт именно на нём, без ORM сверху. В .NET же работать напрямую на «голом» ADO.NET сегодня скорее исключение.

## Драйверы и side-effect импорт

`database/sql` бесполезен без драйвера. Основные драйверы:

- **`github.com/jackc/pgx/v5`** — PostgreSQL, **рекомендуемый** выбор. У pgx два режима: «родной» высокопроизводительный API (`pgx.Connect`, `pgxpool`) и **совместимый с `database/sql`** слой `github.com/jackc/pgx/v5/stdlib`. В этой главе мы используем совместимый слой, чтобы остаться в рамках стандартного API.
- **`github.com/lib/pq`** — старый драйвер PostgreSQL. Работает, но в режиме поддержки (фактически заморожен); для новых проектов берите pgx.
- **`github.com/go-sql-driver/mysql`** — стандарт де-факто для MySQL/MariaDB.

Драйвер подключается необычным для новичка способом — **импортом ради побочного эффекта** (blank import). Сам пакет драйвера вы по имени не используете; его задача — в своей функции `init()` зарегистрировать себя в `database/sql` под строковым именем («pgx», «mysql», ...). Поэтому импорт идёт с пустым идентификатором `_`:

```go
import (
    "database/sql"

    _ "github.com/jackc/pgx/v5/stdlib" // регистрирует драйвер "pgx" через init()
)

func main() {
    db, err := sql.Open("pgx", "postgres://user:pass@localhost:5432/mydb?sslmode=disable")
    // ...
}
```

Пустой `_` нужен потому, что в Go **неиспользуемый импорт — ошибка компиляции**; `_` говорит «импортируй пакет ради его `init()`, по имени я к нему не обращаюсь». Имя в `sql.Open("pgx", ...)` должно совпадать с тем, под которым драйвер себя зарегистрировал.

> **Параллель с .NET:** в современном .NET провайдер подключают явно: `new NpgsqlConnection(connString)` или через `DbProviderFactories.RegisterFactory(...)`. Регистрация драйвера через `init()` + строковое имя ближе к старому `DbProviderFactories` с инвариантным именем провайдера, но в Go это происходит автоматически фактом импорта. Строка подключения (`postgres://...` или DSN `user:pass@tcp(host)/db`) — прямой аналог `ConnectionString`, только её формат задаёт драйвер.

## `sql.DB` — это пул, а не соединение

Самое частое и дорогое заблуждение выходца из ADO.NET. По аналогии с `DbConnection` кажется, что `*sql.DB` — это «одно соединение, которое надо открыть и закрыть». **Это не так.**

`sql.Open` **не открывает ни одного соединения** и обычно даже не ходит в сеть — он лишь готовит объект пула и проверяет, что драйвер с таким именем зарегистрирован. Реальные соединения создаются лениво, при первом запросе. А сам `*sql.DB` — это **потокобезопасный пул соединений**, рассчитанный на конкурентное использование из множества горутин.

Из этого следуют три правила:

- ✅ **Создавайте `*sql.DB` один раз** на всё приложение (или на каждую отдельную БД) и переиспользуйте. Это долгоживущий объект.
- ❌ **Не открывайте `sql.DB` на каждый запрос** и не закрывайте его в `defer` внутри обработчика — вы будете уничтожать и пересоздавать пул, теряя весь смысл пулинга.
- ✅ **Проверяйте доступность БД явно** через `db.PingContext(ctx)` — раз `Open` в сеть не ходит, это единственный способ убедиться на старте, что подключение вообще рабочее.

```go
db, err := sql.Open("pgx", dsn)
if err != nil {
    log.Fatal(err) // ошибка тут — обычно неверный DSN или незарегистрированный драйвер
}
defer db.Close() // закрываем пул при завершении приложения, а не запроса

ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
if err := db.PingContext(ctx); err != nil {
    log.Fatal("БД недоступна:", err) // вот здесь реально проверяется соединение
}
```

> **Параллель с .NET:** в ADO.NET пул соединений тоже есть — он встроен в провайдер и работает **прозрачно**: вы создаёте `new NpgsqlConnection(...)`, делаете `Open()`/`Close()` (или `using`), а провайдер под капотом не открывает физическое соединение каждый раз, а берёт/возвращает его в пул, ключом к которому служит строка подключения. Принципиальная разница: в .NET вы оперируете объектами-соединениями (`DbConnection`), а пул невидим; в Go вы оперируете **самим пулом** (`*sql.DB`), а отдельное соединение видите редко (`db.Conn(ctx)` — нечастый случай). То есть `*sql.DB` ≈ не `DbConnection`, а **пул ADO.NET целиком**, поданный вам как объект. И, как следствие, настройку пула в Go делают кодом, а не параметрами строки подключения (`Maximum Pool Size=...` и т. п.).

## Настройка пула

Пул конфигурируется четырьмя методами `*sql.DB`. У них есть разумные, но не всегда подходящие умолчания, поэтому в продакшене их обычно задают явно:

```go
db.SetMaxOpenConns(25)                  // потолок одновременно открытых соединений (default: 0 = без лимита)
db.SetMaxIdleConns(25)                   // сколько простаивающих держать в пуле (default: 2)
db.SetConnMaxLifetime(5 * time.Minute)   // максимальный возраст соединения (default: 0 = бессрочно)
db.SetConnMaxIdleTime(1 * time.Minute)   // как долго соединение может простаивать (default: 0 = бессрочно)
```

Что важно понимать про каждый:

- **`SetMaxOpenConns(n)`** — жёсткий потолок. Если все `n` соединений заняты, следующий запрос **блокируется** (с уважением к `context`!), ожидая освобождения. По умолчанию лимита нет (0) — это опасно: всплеск нагрузки может открыть сотни соединений и упереться в лимит самой СУБД (`max_connections` в PostgreSQL). Почти всегда стоит задать осознанный потолок.
- **`SetMaxIdleConns(n)`** — сколько свободных соединений переиспользовать. Дефолт `2` часто **слишком мал**: при высокой конкуренции соединения постоянно открываются и закрываются. Типичная рекомендация — держать его равным `MaxOpenConns` (иначе лишние соединения после пика будут сразу закрываться).
- **`SetConnMaxLifetime(d)`** — заставляет периодически пересоздавать соединения. Полезно за load-balancer'ом или прокси (PgBouncer), чтобы соединения не «прилипали» к одному бэкенду и подхватывали ротацию. Разумная отправная точка — несколько минут.
- **`SetConnMaxIdleTime(d)`** — закрывает соединения, простаивавшие дольше `d`. Позволяет пулу «сдуваться» после пика, не дожидаясь истечения полного lifetime.

```mermaid
flowchart LR
    subgraph POOL["*sql.DB — пул"]
        IDLE["простаивающие<br/>(до MaxIdleConns)"]
        BUSY["занятые запросами<br/>(всего ≤ MaxOpenConns)"]
    end
    G1["горутина 1"] -->|QueryContext| POOL
    G2["горутина 2"] -->|ExecContext| POOL
    G3["горутина 3 (все заняты)"] -.->|ждёт освобождения<br/>или ctx.Done| POOL
    POOL --> DB[("СУБД")]
    BUSY -->|вернуть в пул| IDLE
    IDLE -->|ConnMaxIdleTime / Lifetime| CLOSE["закрытие соединения"]
```

> **Параллель с .NET:** это прямые аналоги параметров пула из строки подключения Npgsql/SqlClient: `SetMaxOpenConns` ≈ `Maximum Pool Size`, `SetMaxIdleConns` ≈ `Minimum Pool Size` (по смыслу «сколько держать наготове»), `SetConnMaxLifetime` ≈ `Connection Lifetime` / `Connection Idle Lifetime`. Разница чисто стилистическая: в .NET вы пишете `"...;Maximum Pool Size=25;"` в connection string, в Go — вызываете методы по коду. Поведение «все соединения заняты → ждать» тоже совпадает (в .NET — `Timeout`/`Connection Pool Timeout`), но в Go ожидание управляется `context`, а не отдельным таймаутом пула.

## Запросы: всегда с `context`

`database/sql` предлагает три семейства методов выполнения, и у каждого есть `...Context`-вариант. **Используйте всегда контекстные версии** (`QueryContext`, `QueryRowContext`, `ExecContext`) — они принимают `context.Context` первым аргументом и поэтому уважают таймауты и отмену, прокинутые сверху (из HTTP-обработчика и т. д.). Версии без `Context` (`Query`, `Exec`) существуют для совместимости и фактически вызывают контекстные с `context.Background()` — в новом коде их брать не стоит.

Три метода под три задачи:

| Метод | Когда | Что возвращает |
| --- | --- | --- |
| `QueryContext` | выборка **многих** строк (`SELECT`) | `*sql.Rows` (итератор) |
| `QueryRowContext` | выборка **одной** строки | `*sql.Row` (отложенная ошибка) |
| `ExecContext` | `INSERT`/`UPDATE`/`DELETE`/DDL | `sql.Result` (rows affected, last insert id) |

### Плейсхолдеры зависят от драйвера

Параметры запроса **никогда не вклеивают в строку** (это SQL-инъекция) — их передают отдельными аргументами через плейсхолдеры. Но синтаксис плейсхолдера задаёт **драйвер**, а не `database/sql`:

- **PostgreSQL** (pgx, lib/pq): нумерованные `$1`, `$2`, ...
- **MySQL** (go-sql-driver): позиционные `?`
- (SQL Server через `denisenkom/go-mssqldb`: именованные `@p1` или `?`)

```go
// PostgreSQL
row := db.QueryRowContext(ctx, "SELECT name, email FROM users WHERE id = $1", userID)

// MySQL — тот же смысл, другой плейсхолдер
row := db.QueryRowContext(ctx, "SELECT name, email FROM users WHERE id = ?", userID)
```

> **Параллель с .NET:** аргументы-плейсхолдеры — это параметризованный запрос, как `cmd.Parameters.Add(...)` в ADO.NET (или `new { id }` в Dapper). Защита от инъекций ровно та же. Но в .NET синтаксис параметра (`@id`) у популярных провайдеров более-менее единообразен, а в Go он разный у разных СУБД — это раздражает при переключении и ровно поэтому надстройки вроде `sqlx` дают `Rebind`/именованные параметры (см. следующую главу).

### `QueryRowContext` — одна строка

```go
type User struct {
    ID    int64
    Name  string
    Email string
}

func getUser(ctx context.Context, db *sql.DB, id int64) (User, error) {
    var u User
    err := db.QueryRowContext(ctx,
        "SELECT id, name, email FROM users WHERE id = $1", id,
    ).Scan(&u.ID, &u.Name, &u.Email)

    if errors.Is(err, sql.ErrNoRows) {
        return User{}, fmt.Errorf("user %d not found: %w", id, err)
    }
    if err != nil {
        return User{}, fmt.Errorf("query user %d: %w", id, err)
    }
    return u, nil
}
```

Тонкость `QueryRowContext`: он **никогда не возвращает ошибку сам** — ошибка (включая «строк нет») откладывается до вызова `Scan`. Если строка не найдена, `Scan` вернёт **`sql.ErrNoRows`**; это штатная ситуация, которую проверяют через `errors.Is(err, sql.ErrNoRows)`, а не паникой.

> **Параллель с .NET:** `sql.ErrNoRows` ≈ поведение `QueryFirstOrDefault<T>()` из Dapper (вернул `default`) или `reader.Read() == false`. В EF Core это `FirstOrDefaultAsync()` вернувший `null`. Важно: в Go «нет строки» — это **значение ошибки**, которое надо явно сопоставить, а не `null`.

### `QueryContext` — много строк, `rows.Scan`, обязательный `Close`/`Err`

Выборка множества строк — это итератор `*sql.Rows`. Здесь сосредоточена главная ручная рутина `database/sql` (которую и убирает `sqlx`), и здесь же легко допустить утечку соединения:

```go
func listUsers(ctx context.Context, db *sql.DB) ([]User, error) {
    rows, err := db.QueryContext(ctx, "SELECT id, name, email FROM users ORDER BY id")
    if err != nil {
        return nil, fmt.Errorf("query users: %w", err)
    }
    defer rows.Close() // ОБЯЗАТЕЛЬНО: возвращает соединение в пул

    var users []User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil {
            return nil, fmt.Errorf("scan user: %w", err)
        }
        users = append(users, u)
    }
    // ОБЯЗАТЕЛЬНО: ошибка могла прерваться внутри Next() (обрыв сети и т.п.)
    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("iterate users: %w", err)
    }
    return users, nil
}
```

Три обязательных дисциплины при работе с `*sql.Rows`:

- ✅ **`defer rows.Close()`** сразу после успешного `QueryContext`. Пока `rows` не закрыт (или не вычитан до конца), занятое им соединение **не вернётся в пул**. Забытый `Close` — классическая утечка соединений, которая под нагрузкой исчерпает `MaxOpenConns` и подвесит приложение. `Close` идемпотентен и безопасен даже после полного перебора.
- ✅ **`rows.Scan(&dest...)`** принимает **указатели** на поля назначения, по одному на колонку, в порядке колонок `SELECT`. Число и типы должны совпадать с колонками.
- ✅ **`rows.Err()` после цикла.** Цикл `for rows.Next()` завершается и когда строки кончились, и когда **произошла ошибка** в процессе чтения. Без проверки `rows.Err()` вы молча потеряете ошибку (например, разрыв соединения посреди выборки) и решите, что просто «данные кончились».

> **Параллель с .NET:** `rows.Next()` + `rows.Scan(...)` ≈ `while (await reader.ReadAsync()) { var x = reader.GetInt64(0); ... }` в ADO.NET. `defer rows.Close()` играет роль `using var reader = ...` / `await using` — гарантию освобождения. А вот явная проверка `rows.Err()` в .NET аналога не имеет: там ошибка чтения вылетит исключением прямо из `ReadAsync()`. В Go ошибка не «выпрыгивает», а аккумулируется в `rows.Err()` — отсюда и обязательная проверка. И, конечно, в Go нет удобных типизированных геттеров `GetInt64(0)`: вы передаёте указатели в `Scan` и сами держите порядок колонок — это та самая рутина, ради устранения которой берут `sqlx`/`sqlc`.

### `ExecContext` — изменения

```go
func updateEmail(ctx context.Context, db *sql.DB, id int64, email string) error {
    res, err := db.ExecContext(ctx,
        "UPDATE users SET email = $1 WHERE id = $2", email, id)
    if err != nil {
        return fmt.Errorf("update email: %w", err)
    }
    n, err := res.RowsAffected()
    if err != nil {
        return fmt.Errorf("rows affected: %w", err)
    }
    if n == 0 {
        return fmt.Errorf("user %d not found", id)
    }
    return nil
}
```

`sql.Result` даёт `RowsAffected()` и `LastInsertId()`. Оговорка: `LastInsertId()` поддерживают **не все** драйверы — в частности, PostgreSQL его не предоставляет, и для получения сгенерированного id там используют `INSERT ... RETURNING id` вместе с `QueryRowContext`:

```go
var newID int64
err := db.QueryRowContext(ctx,
    "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
    name, email,
).Scan(&newID)
```

> **Параллель с .NET:** `ExecContext` ≈ `cmd.ExecuteNonQueryAsync()`, а `RowsAffected()` — его возвращаемое число. `LastInsertId()` ≈ `SCOPE_IDENTITY()` / `cmd.ExecuteScalar()` для автоинкремента — и так же, как в SQL Server вы берёте `OUTPUT INSERTED.Id`, в PostgreSQL берут `RETURNING id`.

## `NULL`: `sql.NullString` или указатели

В Go нет «nullable-ссылок» в смысле `string?`, а обычный `string` не может быть `NULL` (его нулевое значение — пустая строка `""`, что **не** то же самое, что `NULL`). Если колонка может содержать `NULL`, прямой `Scan` в `string`/`int64` упадёт с ошибкой. Два решения:

**1. Типы-обёртки `sql.Null*`** — `sql.NullString`, `sql.NullInt64`, `sql.NullBool`, `sql.NullTime`, `sql.NullFloat64` и т. д. Это структуры с полем значения и булевым `Valid`:

```go
var middleName sql.NullString
err := db.QueryRowContext(ctx,
    "SELECT middle_name FROM users WHERE id = $1", id).Scan(&middleName)

if middleName.Valid {
    fmt.Println("отчество:", middleName.String)
} else {
    fmt.Println("отчество не задано (NULL)")
}
```

**2. Указатели** — `*string`, `*int64`: `NULL` ложится в `nil`, значение — в разыменовываемый указатель. Компактнее в коде, но добавляет аллокацию и разыменование:

```go
var middleName *string
err := db.QueryRowContext(ctx, "...").Scan(&middleName)
if middleName != nil { /* значение есть */ }
```

Начиная с Go 1.22 в стандартной библиотеке есть и обобщённый **`sql.Null[T]`** (дженерик), но классические `sql.NullString` и компания остаются самым распространённым стилем.

> **Параллель с .NET:** `sql.NullString` с полем `Valid` — это буквально идея `Nullable<T>` (`int?`) с её `HasValue`/`Value`. Для ссылочных типов в .NET `NULL` естественно ложится в `null` (и nullable reference types `string?` это аннотируют). В Go «обычный» тип `NULL` не принимает, поэтому nullable-семантику приходится вводить явно — либо `sql.Null*`, либо указателем. Это прямое следствие того, что у Go нет отдельной «ссылки, которая может быть null», для значимых типов.

## Транзакции: `BeginTx`/Commit/Rollback с `defer rollback`

Транзакцию открывает `db.BeginTx(ctx, opts)`, возвращая `*sql.Tx`. Все запросы внутри транзакции вызываются **на `tx`** (`tx.ExecContext`, `tx.QueryRowContext`), а не на `db` — иначе они уйдут мимо транзакции, по отдельному соединению из пула. Завершают транзакцию `tx.Commit()` или `tx.Rollback()`.

Идиоматичный паттерн — **`defer tx.Rollback()` сразу после `BeginTx`**:

```go
func transfer(ctx context.Context, db *sql.DB, from, to int64, amount int) error {
    tx, err := db.BeginTx(ctx, nil) // nil = опции по умолчанию (уровень изоляции БД)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback() // сработает, если не дошли до Commit; после Commit — no-op

    if _, err := tx.ExecContext(ctx,
        "UPDATE accounts SET balance = balance - $1 WHERE id = $2", amount, from); err != nil {
        return fmt.Errorf("debit: %w", err) // defer откатит
    }
    if _, err := tx.ExecContext(ctx,
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2", amount, to); err != nil {
        return fmt.Errorf("credit: %w", err) // defer откатит
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit: %w", err)
    }
    return nil // дошли сюда — Commit прошёл, отложенный Rollback станет no-op
}
```

Почему `defer tx.Rollback()` безопасен и удобен: при любом раннем `return` (ошибка на любом шаге) отложенный `Rollback` гарантированно откатит транзакцию — не нужно вызывать откат вручную в каждой ветке. А если мы дошли до `tx.Commit()` и он успешен, последующий `Rollback` из `defer` — это **no-op** (он вернёт `sql.ErrTxDone`, которую здесь штатно игнорируют). Уровень изоляции и режим только-чтения задаются через `&sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: true}` вторым аргументом.

> **Параллель с .NET:** `db.BeginTx` ≈ `conn.BeginTransactionAsync()`, `tx.Commit()`/`tx.Rollback()` — один в один. Паттерн `defer tx.Rollback()` заменяет `using var tx = ...` с откатом в `Dispose()` (если `Commit` не вызван): в .NET откат недокоммиченной транзакции делает `Dispose`, в Go — отложенный `Rollback`. `sql.TxOptions{Isolation: ...}` ≈ `IsolationLevel`, передаваемый в `BeginTransaction`. Ключевой нюанс, на котором спотыкаются: в Go запросы транзакции обязательно идут через `tx`, тогда как в ADO.NET вы присваиваете транзакцию команде (`cmd.Transaction = tx`) — забыть это присваивание там тоже классическая ошибка.

## Prepared statements

`db.PrepareContext(ctx, query)` возвращает `*sql.Stmt` — переиспользуемый подготовленный запрос. Имеет смысл, когда один и тот же запрос выполняется **многократно** (в цикле, в горутинах): сервер парсит и планирует его один раз.

```go
stmt, err := db.PrepareContext(ctx, "SELECT name FROM users WHERE id = $1")
if err != nil {
    return err
}
defer stmt.Close() // освобождает statement на стороне сервера

for _, id := range ids {
    var name string
    if err := stmt.QueryRowContext(ctx, id).Scan(&name); err != nil {
        return err
    }
    fmt.Println(name)
}
```

Важные нюансы в контексте пула:

- `*sql.Stmt`, подготовленный на `*sql.DB`, привязан к **конкретному соединению**; если при выполнении это соединение занято, пул либо берёт другое и **переподготавливает** statement на нём, либо ждёт. Это автоматически, но означает, что на пуле prepared statements не всегда дают ожидаемую экономию.
- Внутри **транзакции** используйте `tx.PrepareContext` (или `tx.StmtContext` для привязки уже готового `Stmt` к `tx`) — тогда statement живёт на том же соединении, что и транзакция.
- Не забывайте `defer stmt.Close()` — это освобождает ресурс и на стороне БД.

Замечание: многие драйверы (в т. ч. pgx) и так используют подготовку под капотом для обычных параметризованных запросов, поэтому в Go явный `Prepare` нужен реже, чем кажется — обычно только для горячего, многократно повторяемого запроса.

> **Параллель с .NET:** `*sql.Stmt` ≈ `DbCommand` с заданным `CommandText`, который вы переиспользуете, меняя параметры (а исторически — `cmd.Prepare()`). В EF Core/Dapper о подготовке вы почти не думаете. Нюанс с привязкой statement к соединению специфичен для Go-шной модели «пул как объект»: в .NET `DbCommand` привязан к открытому вами `DbConnection`, а здесь соединение выбирает пул, поэтому подготовленный на пуле statement может «мигрировать».

## Итог

- `database/sql` — это **абстракция над драйверами** (аналог ADO.NET / `System.Data.Common`), а **не ORM**. Диалог с СУБД ведёт драйвер (`pgx` — рекомендуемый для PostgreSQL, `go-sql-driver/mysql` — для MySQL), подключаемый **side-effect импортом** `_ "..."` ради регистрации в `init()`.
- **`sql.DB` — это пул соединений**, потокобезопасный и долгоживущий: создавайте его **один раз**, переиспользуйте, не открывайте на каждый запрос. `sql.Open` не ходит в сеть — проверяйте связь через `PingContext`. По смыслу `*sql.DB` ≈ **весь пул ADO.NET**, а не одно `DbConnection`.
- Пул настраивают **кодом**: `SetMaxOpenConns` (потолок, иначе можно упереться в лимит СУБД), `SetMaxIdleConns` (дефолт 2 часто мал), `SetConnMaxLifetime`, `SetConnMaxIdleTime`.
- Запросы — **всегда через `...Context`-методы**: `QueryContext` (много строк), `QueryRowContext` (одна; «нет строки» = `sql.ErrNoRows`), `ExecContext` (изменения). Плейсхолдеры зависят от драйвера (`$1` у PostgreSQL, `?` у MySQL).
- При работе с `*sql.Rows` обязательны три вещи: **`defer rows.Close()`** (иначе утечка соединения), `rows.Scan(&...)` с указателями по колонкам и **`rows.Err()`** после цикла (ошибки чтения не «выпрыгивают», а копятся там).
- `NULL` обрабатывают через `sql.NullString`/`sql.NullInt64`/... (поле `Valid`, аналог `Nullable<T>`) или указатели (`*string`).
- Транзакции: `BeginTx` → запросы **на `tx`** → `Commit`/`Rollback`, с идиомой **`defer tx.Rollback()`** (после успешного `Commit` он становится no-op).

Дальше — `sqlx`: тонкая надстройка, которая убирает самую болезненную рутину этой главы (ручной `Scan` по колонкам), оставаясь при этом всё тем же `database/sql` под капотом.

---

[⌂ Главная](../../README.md) · [↑ Раздел](./README.md) · [← Предыдущий: Обзор раздела](./README.md) · [→ Следующий: sqlx](./02-sqlx.md)
