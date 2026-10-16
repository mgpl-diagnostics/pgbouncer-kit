# @mgpl-diagnostics/pgbouncer-kit

Reusable PgBouncer setup for the MGPL Diagnostics services. PgBouncer sits between the services and
PostgreSQL and shares a small number of server connections among many clients, so the api can run
several instances (and its worker) without exhausting PostgreSQL's `max_connections`.

The kit writes PgBouncer's two files and helps you run and watch it:

- **`pgbouncer.ini`** from typed configuration or `PGBOUNCER_*` environment variables, checked
  before it is written (`renderIni`, `configFromEnv`);
- **`userlist.txt`** with SCRAM-SHA-256 verifiers (or MD5), never plain passwords unless you ask
  (`renderUserlist`, `scramVerifier`), plus the SQL that puts the same verifier on PostgreSQL
  (`alterRoleSql`) and a safe `auth_query` setup (`authQuerySetupSql`);
- a **docker-compose service** with a health check (`renderCompose`);
- **TLS** on both sides (apps → PgBouncer, PgBouncer → PostgreSQL);
- a **readiness probe** that needs no credentials (`probePgBouncer`, `waitForPgBouncer`, `readiness`);
- a **CLI**, `mgpl-pgbouncer`, for container entrypoints and one-off setup.

It is a library with **no runtime dependencies** and no framework: use it from a script, a
container entrypoint or a service's start-up code. It does not run PgBouncer itself.

## Where it is used

```mermaid
flowchart LR
  subgraph services["MGPL services (PostgreSQL backend)"]
    api["api: GraphQL server<br/>(one or more instances)"]
    worker["api: worker<br/>(BullMQ jobs)"]
    other["any other service<br/>using db-kit's pg backend"]
  end
  pgb["PgBouncer<br/>(configured by pgbouncer-kit)"]
  pg[("PostgreSQL")]
  api --> pgb
  worker --> pgb
  other --> pgb
  pgb --> pg
  migrate["migrations, seed, pg_dump"] -. "direct, not through PgBouncer" .-> pg
```

| Consumer | How it reaches PostgreSQL today | With pgbouncer-kit |
| --- | --- | --- |
| [api](https://github.com/mgpl-diagnostics/api) server (`src/main.ts`) | `DATABASE_URL` → db-kit `createDb` (Sequelize) | `DATABASE_URL` points at PgBouncer (`pgbouncerUrl`); `GET /health` can include `readiness()` |
| api worker (`src/worker.ts`) | the same container and `DATABASE_URL` | the same PgBouncer, so jobs share the server pool with requests |
| finance-kit, ledger-kit | run inside the api process on db-kit's `Repositories` | nothing to change: they use the api's connection |
| [db-kit](https://github.com/mgpl-diagnostics/db-kit) PostgreSQL backend | `createDb({ url })` | nothing to change: it is transaction-safe (no session `SET`, advisory locks or `LISTEN`) |
| Migrations, `npm run seed`, backups | `DATABASE_URL` | keep a **direct** URL (`DIRECT_DATABASE_URL` or similar): DDL and dumps should not go through transaction pooling |

The MongoDB backend and Redis are not affected. The api will adopt this kit in a later step; until
then, the api's own PgBouncer settings stay where they are.

## Install

```bash
# .npmrc: @mgpl-diagnostics:registry=https://npm.pkg.github.com
npm install @mgpl-diagnostics/pgbouncer-kit
```

Needs Node.js ≥ 20 and PgBouncer **≥ 1.21** (for `max_prepared_statements`; the compose image is 1.25).

## Adopting it in a service

Four steps; the example is the api with docker compose.

**1. Give PostgreSQL and PgBouncer the same SCRAM verifier.** PgBouncer can pass a client's SCRAM
login through to PostgreSQL only when both hold the same verifier. Make one, set it on PostgreSQL,
keep it for PgBouncer:

```bash
printf '%s' "$APP_DB_PASSWORD" | npx mgpl-pgbouncer verifier app
# SCRAM-SHA-256$4096:…        ← goes into PGBOUNCER_USERS (a verifier, not the password)
# ALTER ROLE "app" PASSWORD 'SCRAM-SHA-256$4096:…';   ← run once on PostgreSQL
```

(Alternatives: read the existing verifiers with `PG_SHADOW_QUERY` + `userlistFromRows`, or use
`auth_query`, below.)

**2. Render the files** in the container entrypoint or a deploy step:

```bash
PGBOUNCER_UPSTREAM_URL='postgres://db.internal:5432/mgpl?sslmode=verify-full&sslrootcert=/etc/pgbouncer/tls/ca.crt' \
PGBOUNCER_USERS="app:$APP_SCRAM_VERIFIER" \
sudo -E npx mgpl-pgbouncer render --out ./pgbouncer --chown 70
# wrote ./pgbouncer/pgbouncer.ini and ./pgbouncer/userlist.txt (1 users)
```

`userlist.txt` is written with mode 600; the compose image runs as `postgres` (uid 70), so it must
own the file (`--chown 70`, which needs root, or `chown 70:70` afterwards).

**3. Add the compose service** and point the services at it:

```bash
npx mgpl-pgbouncer compose --tls-dir ./tls > compose.pgbouncer.yml
docker compose -f compose.yml -f compose.pgbouncer.yml up -d
```

```yaml
# compose.yml (the api's services)
services:
  api:
    environment:
      DATABASE_URL: postgres://app:${APP_DB_PASSWORD}@pgbouncer:6432/mgpl
    depends_on:
      pgbouncer: { condition: service_healthy }
  worker:
    environment:
      DATABASE_URL: postgres://app:${APP_DB_PASSWORD}@pgbouncer:6432/mgpl
```

Or derive the URL in code: `pgbouncerUrl(process.env.DATABASE_URL, { host: "pgbouncer" })`.

**4. Size the app's own pool and add readiness.** Each app instance keeps its Sequelize pool
(`pool.max`, default 5); PgBouncer multiplexes all of them onto `default_pool_size` server
connections per user and database. Keep `instances × pool.max` ≤ `max_client_conn`, and
`default_pool_size + reserve_pool_size` below PostgreSQL's `max_connections` minus what admin tools need.

```ts
import { readiness, waitForPgBouncer } from "@mgpl-diagnostics/pgbouncer-kit";

await waitForPgBouncer({ host: "pgbouncer", port: 6432 });            // at start-up
const ready = readiness({ host: "pgbouncer", port: 6432, query: () => db.sequelize.query("SELECT 1") });
// in GET /health: const r = await ready(); reply.code(r.ok ? 200 : 503).send(r);
```

Things that break under transaction pooling, and must not be used through PgBouncer: `SET` outside
a transaction (use `SET LOCAL`), session advisory locks (`pg_advisory_xact_lock` is fine), `LISTEN`,
`WITH HOLD` cursors, temporary tables that outlive a transaction. db-kit uses none of them.

## Configuration in code

```ts
import { defineConfig, renderIni, renderUserlist } from "@mgpl-diagnostics/pgbouncer-kit";

const config = defineConfig({
  databases: [{ name: "mgpl", host: "db.internal", port: 5432 }],
  defaultPoolSize: 25,
  serverTls: { mode: "verify-full", caFile: "/etc/pgbouncer/tls/ca.crt" },
  statsUsers: ["metrics"],
});
await writeFile("pgbouncer.ini", renderIni(config));
await writeFile("userlist.txt", renderUserlist([{ user: "app", secret: verifier }]), { mode: 0o600 });
```

`defineConfig` checks everything and throws `PGBOUNCER_BAD_CONFIG` with **every** problem listed in
`error.problems`. Values cannot inject lines or settings; database entries cannot carry passwords;
`trust` and `any` auth are refused.

### Defaults, and why

| Setting | Default | Why |
| --- | --- | --- |
| `pool_mode` | `transaction` | the point of PgBouncer for a stateless API; db-kit is transaction-safe |
| `listen_addr` / `listen_port` | `0.0.0.0` / `6432` | a container on a private network; PgBouncer's usual port |
| `auth_type` | `scram-sha-256` | PostgreSQL's default since 14; MD5 is legacy |
| `max_client_conn` | 500 | many app instances × their pools |
| `default_pool_size` | 20 | server connections per user + database |
| `min_pool_size` | 0 | no idle connections held open |
| `reserve_pool_size` / `reserve_pool_timeout` | 5 / 3 s | a little headroom for bursts |
| `max_db_connections` | 0 (no cap) | PgBouncer's default; set it when several users share one database |
| `max_prepared_statements` | 200 | named prepared statements work in transaction mode (PgBouncer ≥ 1.21) |
| `server_lifetime` / `server_idle_timeout` | 3600 s / 600 s | PgBouncer's defaults |
| `query_wait_timeout` | 120 s | PgBouncer's default |
| `ignore_startup_parameters` | `extra_float_digits` | sent by some drivers; harmless |
| `client_tls_sslmode` | `disable` | apps reach PgBouncer over the private compose network |
| `server_tls_sslmode` | `prefer`, or the upstream URL's `sslmode` | use `verify-full` with managed PostgreSQL |
| `log_connections` / `log_disconnections` | off | busy pools are noisy; pooler errors stay on |
| admin / stats users | none | add them explicitly |

### Environment variables

`configFromEnv(env)` and `usersFromEnv(env)` read these (also exported as `ENV_VARS`). Bad values
throw `PGBOUNCER_BAD_ENV` listing every problem.

| Variable | Sets |
| --- | --- |
| `PGBOUNCER_UPSTREAM_URL` | PostgreSQL URL PgBouncer forwards to (host, port, database; user and password go to the userlist) |
| `PGBOUNCER_DATABASES` | more upstreams, comma-separated `[name=]postgres://…` |
| `PGBOUNCER_USERS` | extra users, comma-separated `user:secret` (SCRAM verifier, md5 secret, or a percent-encoded password) |
| `PGBOUNCER_USER_SECRET` | how plain passwords are stored: `scram` (default), `md5`, `plain` |
| `PGBOUNCER_LISTEN_ADDR`, `PGBOUNCER_LISTEN_PORT` | `listen_addr`, `listen_port` |
| `PGBOUNCER_POOL_MODE` | `pool_mode` |
| `PGBOUNCER_MAX_CLIENT_CONN`, `PGBOUNCER_DEFAULT_POOL_SIZE`, `PGBOUNCER_MIN_POOL_SIZE` | pool sizes |
| `PGBOUNCER_RESERVE_POOL_SIZE`, `PGBOUNCER_RESERVE_POOL_TIMEOUT`, `PGBOUNCER_MAX_DB_CONNECTIONS` | reserve and caps |
| `PGBOUNCER_MAX_PREPARED_STATEMENTS` | `max_prepared_statements` |
| `PGBOUNCER_SERVER_LIFETIME`, `PGBOUNCER_SERVER_IDLE_TIMEOUT`, `PGBOUNCER_SERVER_CONNECT_TIMEOUT` | server connection timing (seconds) |
| `PGBOUNCER_QUERY_WAIT_TIMEOUT`, `PGBOUNCER_CLIENT_IDLE_TIMEOUT`, `PGBOUNCER_IDLE_TRANSACTION_TIMEOUT` | client timing (seconds) |
| `PGBOUNCER_AUTH_TYPE`, `PGBOUNCER_AUTH_FILE`, `PGBOUNCER_AUTH_HBA_FILE` | `auth_type`, `auth_file`, `auth_hba_file` |
| `PGBOUNCER_AUTH_QUERY`, `PGBOUNCER_AUTH_USER`, `PGBOUNCER_AUTH_DBNAME` | `auth_query`, `auth_user`, `auth_dbname` |
| `PGBOUNCER_AUTH_PASSWORD` | password of the auth user, written in plain text (PgBouncer logs in as it) |
| `PGBOUNCER_ADMIN_USERS`, `PGBOUNCER_STATS_USERS` | console users, comma-separated |
| `PGBOUNCER_IGNORE_STARTUP_PARAMETERS` | comma-separated |
| `PGBOUNCER_LOG_CONNECTIONS` | `true` / `false` |
| `PGBOUNCER_CLIENT_TLS_SSLMODE`, `PGBOUNCER_CLIENT_TLS_CERT_FILE`, `PGBOUNCER_CLIENT_TLS_KEY_FILE`, `PGBOUNCER_CLIENT_TLS_CA_FILE`, `PGBOUNCER_CLIENT_TLS_PROTOCOLS`, `PGBOUNCER_CLIENT_TLS_CIPHERS` | apps → PgBouncer TLS |
| `PGBOUNCER_SERVER_TLS_SSLMODE`, `PGBOUNCER_SERVER_TLS_CERT_FILE`, `PGBOUNCER_SERVER_TLS_KEY_FILE`, `PGBOUNCER_SERVER_TLS_CA_FILE`, `PGBOUNCER_SERVER_TLS_PROTOCOLS`, `PGBOUNCER_SERVER_TLS_CIPHERS` | PgBouncer → PostgreSQL TLS (defaults from the upstream URL's `sslmode` and `sslrootcert`) |

The upstream URL's password is only used for the userlist, never written to `pgbouncer.ini`.

## Users and authentication

PgBouncer checks each client against `userlist.txt` and then logs in to PostgreSQL as the same user.
With SCRAM it can only do the second step when its verifier **equals** PostgreSQL's. Three ways:

1. **Same verifier on both sides** (recommended): `scramVerifier(password)` once, `alterRoleSql(user, verifier)`
   on PostgreSQL, the verifier in `PGBOUNCER_USERS`. The password never reaches PgBouncer's files.
2. **Copy PostgreSQL's verifiers**: run `PG_SHADOW_QUERY` as a superuser, `userlistFromRows(rows)`.
3. **`auth_query`**: PgBouncer looks users up in PostgreSQL. Run `authQuerySetupSql("pgbouncer_auth")`
   once (it creates a role and a `SECURITY DEFINER` lookup that never returns superusers), set
   `auth.query: AUTH_QUERY`, `auth.user: "pgbouncer_auth"`, and put that user in the userlist with
   `format: "plain"` (`PGBOUNCER_AUTH_PASSWORD`): PgBouncer logs in as it itself.

A plain password in `renderUserlist` becomes a SCRAM verifier with a random salt, which works for
client logins but not for SCRAM pass-through unless PostgreSQL gets the same verifier (way 1).
`saslprep` normalises passwords exactly as PostgreSQL does; `npm test` checks verifiers against
PostgreSQL for ASCII and Unicode passwords.

## TLS

```ts
defineConfig({
  databases: [...],
  clientTls: { mode: "require", certFile: "/etc/pgbouncer/tls/server.crt", keyFile: "/etc/pgbouncer/tls/server.key" },
  serverTls: { mode: "verify-full", caFile: "/etc/pgbouncer/tls/ca.crt", protocols: "secure" },
});
```

Client TLS needs a certificate and key; `verify-ca` / `verify-full` need a CA file; `auth.type: "cert"`
needs client TLS. Mount the files with `renderCompose({ tlsDir: "./tls" })` (read-only at `/etc/pgbouncer/tls`).

## Health

- `probePgBouncer({ host, port, timeoutMs })` opens a TCP connection, sends PostgreSQL's SSLRequest and
  reads the one-byte answer: up, speaking the protocol, and whether it offers TLS. No credentials, no pool slot.
- `waitForPgBouncer({ ..., waitMs, intervalMs })` retries until it answers, else `PGBOUNCER_UNREACHABLE`.
- `readiness({ ..., query })` returns a function for a health endpoint; `query` is an optional
  end-to-end check with your own driver. Errors are summarised (first line, 200 characters), never thrown.

The compose service uses `pg_isready` from the image for its own health check.

## CLI

```text
mgpl-pgbouncer render [--out DIR] [--chown UID[:GID]]
                                        pgbouncer.ini + userlist.txt (mode 600) from PGBOUNCER_* variables
mgpl-pgbouncer verifier USER            password on stdin → SCRAM verifier + ALTER ROLE statement
mgpl-pgbouncer auth-setup [AUTH_USER]   SQL for auth_query
mgpl-pgbouncer compose [--name N] [--port P] [--config-dir D] [--tls-dir D] [--publish [IP:]PORT] [--image I] [--depends-on a,b]
mgpl-pgbouncer check [--host H] [--port P] [--wait MS]
```

It prints paths and verifiers, never a password.

## Errors

`PgBouncerError.code` is a public contract (add, never rename); `error.problems` lists every problem.

| Code | When |
| --- | --- |
| `PGBOUNCER_BAD_CONFIG` | `defineConfig` / `renderIni` / compose options are invalid |
| `PGBOUNCER_BAD_ENV` | a `PGBOUNCER_*` variable is invalid or missing |
| `PGBOUNCER_BAD_URL` | not a `postgres://` URL |
| `PGBOUNCER_BAD_USER` | bad user name, empty or multi-line password, malformed verifier, duplicate user |
| `PGBOUNCER_UNREACHABLE` | `waitForPgBouncer` gave up |

## Develop

```bash
npm run typecheck && npm test && npm run build
npm run llms   # regenerate llms-full.txt (CI fails when it is stale)
```

`npm test` runs the unit checks and, when PostgreSQL (`PG_BIN`, default the newest
`/usr/lib/postgresql/*/bin`) and PgBouncer (`PGBOUNCER_BIN`, default on `PATH`) are installed, a real
PostgreSQL and real PgBouncers: SCRAM pass-through with the kit's verifiers, `auth_query`, transaction
pooling with prepared statements, the admin console, and the CLI's files. CI installs both and sets
`REQUIRE_PGBOUNCER=1`, so nothing is skipped there.

## Licence

All rights reserved (see [LICENSE](LICENSE)).
