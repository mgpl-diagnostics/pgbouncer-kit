# AGENTS.md — @mgpl-diagnostics/pgbouncer-kit

Reusable PgBouncer setup for the MGPL Diagnostics services: env-driven `pgbouncer.ini`, SCRAM/MD5
userlists, `auth_query` SQL, a docker-compose service, TLS options, a readiness probe and the
`mgpl-pgbouncer` CLI. **A library: no server, no GraphQL, no runtime dependencies. It does not run
PgBouncer.** Consumers: the api server and worker (and any service on db-kit's PostgreSQL backend);
see the README's "Where it is used".

## Map

```
src/errors.ts     PgBouncerError (codes + problems), isPgBouncerError
src/config.ts     PgBouncerConfig, DEFAULT_CONFIG, defineConfig (fills defaults, lists every problem)
src/ini.ts        renderIni → pgbouncer.ini (no passwords)
src/env.ts        ENV_VARS, configFromEnv, usersFromEnv, secretFormatFromEnv
src/userlist.ts   saslprep, scramVerifier, verifyScram, md5Secret, renderUserlist/parseUserlist,
                  userlistFromRows + PG_SHADOW_QUERY, alterRoleSql, authQuerySetupSql + AUTH_QUERY
src/url.ts        parsePostgresUrl, pgbouncerUrl (rewrite DATABASE_URL to go through PgBouncer)
src/compose.ts    DEFAULT_IMAGE, composeService, renderCompose (YAML)
src/health.ts     probePgBouncer (SSLRequest), waitForPgBouncer, readiness
src/cli.ts        mgpl-pgbouncer: render, verifier, auth-setup, compose, check
scripts/test.ts   unit checks + real PostgreSQL and PgBouncer (SCRAM pass-through, auth_query, CLI files)
```

## Rules

1. **No passwords in pgbouncer.ini.** Database entries never carry one (`defineConfig` refuses it);
   passwords and verifiers live only in the userlist, written with mode 600.
2. **SCRAM by default.** Plain passwords become verifiers unless the caller asks for `plain` (the
   `auth_query` user is the one case that needs it). `scramVerifier` must equal PostgreSQL's for the
   same salt; the integration test checks ASCII and Unicode passwords against a real server.
3. **Every written value is checked.** No control characters, no line breaks, no `=`/quotes/spaces in
   names, no setting set twice (`extra` cannot repeat a key the kit owns). `trust`/`any` auth are refused.
4. **Errors list every problem** (`error.problems`). Codes (`PgBouncerError.code`) are a public
   contract: add, never rename.
5. **The probe uses no credentials** and holds no pool slot. Health output never contains a password.
6. Every new environment variable goes in `ENV_VARS` **and** the README table (a test checks both).
7. Defaults are documented in the README's "Defaults, and why"; change both together.
8. Zero runtime dependencies; Node.js built-ins only. `pg` is a dev dependency for the tests.
9. The kit does not edit consumers. The api adopts it in its own PR.
10. Never commit secrets, `.env` files, certificates or patient data. Tests use throwaway values.

## Commands

```bash
npm run typecheck && npm test && npm run build
npm run llms      # regenerate llms-full.txt (CI fails when it is stale)
```

`npm test` needs PostgreSQL (`PG_BIN`) and PgBouncer (`PGBOUNCER_BIN` or on PATH) for the integration
part; without them it is skipped locally. CI installs both and sets `REQUIRE_PGBOUNCER=1`. As root,
the servers run as `PG_TEST_USER` (default `nobody`).

## Repository rules

`main` takes pull requests only: squash merge, 1 code-owner review (`@BackStacked`), the `ci` check
required. Rules come from `mgpl-diagnostics/.github` (`scripts/protect-repos.mjs`).

## Licence

All rights reserved (see LICENSE).
