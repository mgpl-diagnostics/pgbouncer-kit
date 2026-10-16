// pgbouncer-kit checks: configuration, ini, environment, userlists, URLs, compose, the probe, the CLI,
// and real PostgreSQL + PgBouncer: SCRAM pass-through with our verifiers, auth_query, transaction
// pooling with prepared statements, and the CLI's files running a real PgBouncer.
// Binaries: PG_BIN (folder with initdb/postgres; default the newest /usr/lib/postgresql/*/bin) and
// PGBOUNCER_BIN (default `pgbouncer` on PATH). Without them the integration part is skipped;
// CI sets REQUIRE_PGBOUNCER=1 so it never skips. As root, servers run as PG_TEST_USER (default nobody).
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import {
  AUTH_QUERY,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE,
  ENV_VARS,
  PgBouncerError,
  alterRoleSql,
  authQuerySetupSql,
  composeService,
  configFromEnv,
  defineConfig,
  md5Secret,
  parsePostgresUrl,
  parseScramVerifier,
  parseUserlist,
  pgbouncerUrl,
  probePgBouncer,
  readiness,
  renderCompose,
  renderIni,
  renderUserlist,
  saslprep,
  scramVerifier,
  secretFormatFromEnv,
  userlistFromRows,
  usersFromEnv,
  verifyScram,
  waitForPgBouncer,
  type PgBouncerErrorCode,
} from "../src/index";

let passed = 0;
let skipped = 0;
const failures: string[] = [];
async function check(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`✗ ${name}\n    ${(e as Error).stack?.split("\n").slice(0, 5).join("\n    ")}`);
  }
}
function code(fn: () => unknown, expected: PgBouncerErrorCode): PgBouncerError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PgBouncerError, `expected PgBouncerError, got ${String(e)}`);
    assert.equal(e.code, expected, e.message);
    return e;
  }
  assert.fail(`expected ${expected}`);
}
const db = { name: "mgpl", host: "postgres" };
const iniValue = (ini: string, key: string) => new RegExp(`^${key} = (.*)$`, "m").exec(ini)?.[1];

// ---- configuration ---------------------------------------------------------------------------

await check("defaults: transaction pooling, scram, 6432, client TLS off, server TLS prefer", () => {
  const c = defineConfig({ databases: [db] });
  assert.equal(c.poolMode, "transaction");
  assert.equal(c.auth.type, "scram-sha-256");
  assert.equal(c.listenPort, 6432);
  assert.equal(c.defaultPoolSize, 20);
  assert.equal(c.maxPreparedStatements, 200);
  assert.equal(c.clientTls.mode, "disable");
  assert.equal(c.serverTls.mode, "prefer");
  assert.notEqual(c.adminUsers, DEFAULT_CONFIG.adminUsers, "lists are copied, not shared");
});

await check("defineConfig lists every problem at once", () => {
  const e = code(
    () =>
      defineConfig({
        databases: [{ name: "bad name", host: "h" }, { name: "pgbouncer", host: "h" }],
        poolMode: "sometimes" as never,
        listenPort: 70000,
        minPoolSize: 50,
        auth: { type: "trust" as never },
      }),
    "PGBOUNCER_BAD_CONFIG",
  );
  assert.ok(e.problems.length >= 5, e.problems.join("; "));
  for (const bit of ["databases[0].name", "reserved", "poolMode", "listenPort", "minPoolSize", "auth.type"]) {
    assert.ok(e.problems.some((p) => p.includes(bit)), `missing problem about ${bit}`);
  }
});

await check("no databases, duplicates and passwords in database entries are refused", () => {
  code(() => defineConfig({ databases: [] }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db, db] }), "PGBOUNCER_BAD_CONFIG");
  const e = code(() => defineConfig({ databases: [{ ...db, password: "x" } as never] }), "PGBOUNCER_BAD_CONFIG");
  assert.match(e.message, /userlist/);
});

await check("values cannot inject lines or settings", () => {
  code(() => defineConfig({ databases: [{ name: "a", host: "h\nlisten_port = 1" }] }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [{ name: "a", host: "h port=1" }] }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db], serverResetQuery: "DISCARD ALL\nauth_type = trust" }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db], extra: { auth_type: "trust" } }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db], extra: { client_tls_sslmode: "disable" } }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db], extra: { "bad key": 1 } }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db], adminUsers: ["a b"] }), "PGBOUNCER_BAD_CONFIG");
});

await check("TLS rules: client TLS needs cert+key, verify modes need a CA, cert auth needs client TLS", () => {
  code(() => defineConfig({ databases: [db], clientTls: { mode: "require" } }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db], serverTls: { mode: "verify-full" } }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db], serverTls: { mode: "prefer", certFile: "/c" } }), "PGBOUNCER_BAD_CONFIG");
  code(() => defineConfig({ databases: [db], auth: { type: "cert" } }), "PGBOUNCER_BAD_CONFIG");
  defineConfig({
    databases: [db],
    clientTls: { mode: "require", certFile: "/tls/server.crt", keyFile: "/tls/server.key" },
    serverTls: { mode: "verify-full", caFile: "/tls/ca.crt" },
  });
});

await check("auth_query needs an auth user", () => {
  code(() => defineConfig({ databases: [db], auth: { query: AUTH_QUERY } }), "PGBOUNCER_BAD_CONFIG");
  defineConfig({ databases: [db], auth: { query: AUTH_QUERY, user: "pgbouncer_auth" } });
  defineConfig({ databases: [{ ...db, authUser: "pgbouncer_auth" }], auth: { query: AUTH_QUERY } });
});

// ---- ini -------------------------------------------------------------------------------------

await check("renderIni: [databases] line, settings, no password anywhere", () => {
  const ini = renderIni({
    databases: [db, { name: "reports", host: "10.0.0.5", port: 6543, dbname: "mgpl_reports", poolSize: 5, poolMode: "session" }, { name: "*", host: "postgres" }],
    adminUsers: ["ops"],
    statsUsers: ["metrics", "ops"],
    auth: { query: AUTH_QUERY, user: "pgbouncer_auth", dbname: "mgpl" },
    serverTls: { mode: "verify-full", caFile: "/etc/pgbouncer/tls/ca.crt", protocols: "tlsv1.3" },
    extra: { unix_socket_dir: "", tcp_keepalive: true, so_reuseport: 1 },
  });
  assert.match(ini, /^\[databases\]$/m);
  assert.match(ini, /^mgpl = host=postgres port=5432 dbname=mgpl$/m);
  assert.match(ini, /^reports = host=10\.0\.0\.5 port=6543 dbname=mgpl_reports pool_mode=session pool_size=5$/m);
  assert.match(ini, /^\* = host=postgres port=5432$/m);
  assert.equal(iniValue(ini, "pool_mode"), "transaction");
  assert.equal(iniValue(ini, "auth_type"), "scram-sha-256");
  assert.equal(iniValue(ini, "auth_query"), AUTH_QUERY);
  assert.equal(iniValue(ini, "auth_dbname"), "mgpl");
  assert.equal(iniValue(ini, "admin_users"), "ops");
  assert.equal(iniValue(ini, "stats_users"), "metrics, ops");
  assert.equal(iniValue(ini, "client_tls_sslmode"), "disable");
  assert.equal(iniValue(ini, "server_tls_sslmode"), "verify-full");
  assert.equal(iniValue(ini, "server_tls_protocols"), "tlsv1.3");
  assert.equal(iniValue(ini, "tcp_keepalive"), "1");
  assert.equal(iniValue(ini, "ignore_startup_parameters"), "extra_float_digits");
  assert.doesNotMatch(ini, /password/i);
  assert.ok(ini.endsWith("\n"));
  // every [pgbouncer] line is "key = value"
  const body = ini.split("[pgbouncer]")[1]!;
  for (const line of body.split("\n").filter(Boolean)) assert.match(line, /^[a-z_]+ = /);
});

await check("renderIni checks its input", () => {
  code(() => renderIni({ databases: [] }), "PGBOUNCER_BAD_CONFIG");
});

// ---- environment -----------------------------------------------------------------------------

await check("configFromEnv: upstream URL, numbers, lists, TLS from the URL's sslmode", () => {
  const c = configFromEnv({
    PGBOUNCER_UPSTREAM_URL: "postgres://app:s3cret@db.internal:5433/mgpl?sslmode=verify-full&sslrootcert=/tls/ca.crt",
    PGBOUNCER_DATABASES: "reports=postgres://db.internal/mgpl_reports, postgres://other:5432/audit",
    PGBOUNCER_DEFAULT_POOL_SIZE: "40",
    PGBOUNCER_POOL_MODE: "session",
    PGBOUNCER_ADMIN_USERS: "ops, admin",
    PGBOUNCER_LOG_CONNECTIONS: "true",
    PGBOUNCER_SERVER_TLS_PROTOCOLS: "tlsv1.3",
  });
  assert.deepEqual(c.databases, [
    { name: "mgpl", host: "db.internal", port: 5433 },
    { name: "reports", host: "db.internal", port: 5432, dbname: "mgpl_reports" },
    { name: "audit", host: "other", port: 5432 },
  ]);
  assert.equal(c.defaultPoolSize, 40);
  assert.equal(c.poolMode, "session");
  assert.deepEqual(c.adminUsers, ["ops", "admin"]);
  assert.equal(c.logConnections, true);
  assert.deepEqual(c.serverTls, { mode: "verify-full", caFile: "/tls/ca.crt", protocols: "tlsv1.3" });
  assert.doesNotMatch(renderIni(c), /s3cret/);
});

await check("configFromEnv: PGBOUNCER_SERVER_TLS_SSLMODE wins over the URL", () => {
  const c = configFromEnv({ PGBOUNCER_UPSTREAM_URL: "postgres://h/d?sslmode=require", PGBOUNCER_SERVER_TLS_SSLMODE: "disable" });
  assert.equal(c.serverTls.mode, "disable");
});

await check("configFromEnv lists every bad variable", () => {
  const e = code(
    () => configFromEnv({ PGBOUNCER_UPSTREAM_URL: "mysql://x", PGBOUNCER_LISTEN_PORT: "abc", PGBOUNCER_POOL_MODE: "x", PGBOUNCER_LOG_CONNECTIONS: "maybe" }),
    "PGBOUNCER_BAD_ENV",
  );
  assert.equal(e.problems.length, 4, e.problems.join("; "));
  code(() => configFromEnv({}), "PGBOUNCER_BAD_ENV");
  code(() => configFromEnv({ PGBOUNCER_UPSTREAM_URL: "postgres://h/d", PGBOUNCER_LISTEN_PORT: "99999" }), "PGBOUNCER_BAD_CONFIG");
});

await check("ENV_VARS documents every variable the code reads", () => {
  const src = readFileSync(new URL("../src/env.ts", import.meta.url), "utf8");
  const read = new Set([...src.matchAll(/"(PGBOUNCER_[A-Z_]+)"/g)].map((m) => m[1]!));
  for (const side of ["CLIENT", "SERVER"]) for (const s of ["SSLMODE", "CERT_FILE", "KEY_FILE", "CA_FILE", "PROTOCOLS", "CIPHERS"]) read.add(`PGBOUNCER_${side}_TLS_${s}`);
  for (const v of read) if (!v.endsWith("_") && !/^PGBOUNCER_(BAD_|UNREACHABLE)/.test(v)) assert.ok(v in ENV_VARS, `${v} is missing from ENV_VARS`);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const v of Object.keys(ENV_VARS)) assert.ok(readme.includes(v), `${v} is missing from the README`);
});

await check("usersFromEnv: URL credentials, PGBOUNCER_USERS (verifiers as they are, passwords decoded)", () => {
  const v = scramVerifier("pw");
  const users = usersFromEnv({
    PGBOUNCER_UPSTREAM_URL: "postgres://app:p%40ss@h/d",
    PGBOUNCER_USERS: `ops:${v},legacy:md5${"a".repeat(32)},odd:a%2Cb%3Ac`,
  });
  assert.deepEqual(users, [
    { user: "app", secret: "p@ss" },
    { user: "ops", secret: v },
    { user: "legacy", secret: `md5${"a".repeat(32)}` },
    { user: "odd", secret: "a,b:c" },
  ]);
  code(() => usersFromEnv({ PGBOUNCER_USERS: "nopassword" }), "PGBOUNCER_BAD_ENV");
  code(() => usersFromEnv({ PGBOUNCER_AUTH_PASSWORD: "x" }), "PGBOUNCER_BAD_ENV");
  assert.deepEqual(usersFromEnv({ PGBOUNCER_AUTH_USER: "pgbouncer_auth", PGBOUNCER_AUTH_PASSWORD: "a b" }), [
    { user: "pgbouncer_auth", secret: "a b", format: "plain" },
  ]);
  assert.equal(secretFormatFromEnv({}), "scram");
  code(() => secretFormatFromEnv({ PGBOUNCER_USER_SECRET: "sha1" }), "PGBOUNCER_BAD_ENV");
});

// ---- userlist --------------------------------------------------------------------------------

await check("md5Secret matches PostgreSQL's md5(password || user)", () => {
  // md5("pencil" + "user")
  assert.equal(md5Secret("user", "pencil"), "md520c46e3762c864548e296b33c3406aa9");
  assert.notEqual(md5Secret("user", "pencil"), md5Secret("user2", "pencil"));
});

await check("scramVerifier: format, salt reuse reproduces, verifyScram", () => {
  const v = scramVerifier("pencil");
  const p = parseScramVerifier(v)!;
  assert.equal(p.iterations, 4096);
  assert.equal(p.salt.length, 16);
  assert.equal(p.storedKey.length, 32);
  assert.equal(scramVerifier("pencil", { salt: p.salt }), v);
  assert.notEqual(scramVerifier("pencil"), v, "random salt");
  assert.ok(verifyScram("pencil", v));
  assert.ok(!verifyScram("pencil2", v));
  assert.ok(!verifyScram("pencil", "nonsense"));
  assert.equal(parseScramVerifier("SCRAM-SHA-256$x"), null);
});

await check("scramVerifier: RFC 7677 keys for user/pencil", async () => {
  // RFC 7677 §3: salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations; ServerSignature there verifies with this ServerKey.
  const v = scramVerifier("pencil", { salt: Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64") });
  const p = parseScramVerifier(v)!;
  // AuthMessage from the RFC; ServerSignature = HMAC(ServerKey, AuthMessage) = 6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=
  const auth = "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
  const { createHmac } = await import("node:crypto");
  assert.equal(createHmac("sha256", p.serverKey).update(auth).digest("base64"), "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
});

await check("saslprep: ASCII unchanged, non-ASCII spaces mapped, soft hyphen dropped, NFKC", () => {
  assert.equal(saslprep("pencil"), "pencil");
  assert.equal(saslprep("a b"), "a b");
  assert.equal(saslprep("I­X"), "IX");
  assert.equal(saslprep("Ⅸ"), "IX");
  assert.equal(saslprep("a\u0007b"), "a\u0007b", "prohibited → raw bytes, as PostgreSQL does");
});

await check("renderUserlist / parseUserlist: quoting, formats, duplicates, round trip", () => {
  const v = scramVerifier("x");
  const text = renderUserlist([
    { user: "app", secret: v },
    { user: "plain", secret: 'pa"ss' },
  ], "plain");
  assert.equal(text, `"app" "${v}"\n"plain" "pa""ss"\n`);
  assert.deepEqual(parseUserlist(`; comment\n\n${text}`), [{ user: "app", secret: v }, { user: "plain", secret: 'pa"ss' }]);
  const scram = parseUserlist(renderUserlist([{ user: "app", secret: "pw" }]))[0]!;
  assert.ok(verifyScram("pw", scram.secret), "plain passwords become SCRAM by default");
  assert.equal(parseUserlist(renderUserlist([{ user: "app", secret: "pw" }], "md5"))[0]!.secret, md5Secret("app", "pw"));
  code(() => renderUserlist([{ user: "a", secret: "1" }, { user: "a", secret: "2" }]), "PGBOUNCER_BAD_USER");
  code(() => renderUserlist([{ user: 'a"b', secret: "1" }]), "PGBOUNCER_BAD_USER");
  code(() => renderUserlist([{ user: "a", secret: "x\ny" }]), "PGBOUNCER_BAD_USER");
  code(() => renderUserlist([{ user: "a", secret: "SCRAM-SHA-256$broken" }]), "PGBOUNCER_BAD_USER");
  code(() => renderUserlist([{ user: "a", secret: "" }]), "PGBOUNCER_BAD_USER");
  assert.equal(renderUserlist([]), "");
});

await check("userlistFromRows, alterRoleSql, authQuerySetupSql", () => {
  const v = scramVerifier("x");
  assert.equal(userlistFromRows([{ usename: "app", passwd: v }, { usename: "nologin", passwd: null }]), `"app" "${v}"\n`);
  assert.equal(alterRoleSql("app", v), `ALTER ROLE "app" PASSWORD '${v}';`);
  code(() => alterRoleSql("app", "plaintext"), "PGBOUNCER_BAD_USER");
  code(() => alterRoleSql("a'b", v), "PGBOUNCER_BAD_USER");
  const sql = authQuerySetupSql();
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /NOT usesuper/);
  assert.match(sql, /REVOKE ALL ON FUNCTION pgbouncer\.user_lookup\(text\) FROM PUBLIC/);
});

// ---- URLs ------------------------------------------------------------------------------------

await check("parsePostgresUrl and pgbouncerUrl", () => {
  const p = parsePostgresUrl("postgresql://app:p%40ss@[::1]:5433/mgpl?sslmode=require&application_name=api");
  assert.deepEqual(p, { host: "::1", port: 5433, database: "mgpl", user: "app", password: "p@ss", params: { sslmode: "require", application_name: "api" } });
  assert.equal(parsePostgresUrl("postgres://app@h").database, "app");
  code(() => parsePostgresUrl("mysql://h/d"), "PGBOUNCER_BAD_URL");
  code(() => parsePostgresUrl("not a url"), "PGBOUNCER_BAD_URL");
  assert.equal(
    pgbouncerUrl("postgres://app:p%40ss@db.internal:5432/mgpl?application_name=api", { host: "pgbouncer" }),
    "postgres://app:p%40ss@pgbouncer:6432/mgpl?application_name=api",
  );
  assert.equal(pgbouncerUrl("postgres://a:b@h/d", { host: "::1", port: 7000, database: "alias" }), "postgres://a:b@[::1]:7000/alias");
});

// ---- compose ---------------------------------------------------------------------------------

await check("composeService / renderCompose", () => {
  const { name, service } = composeService();
  assert.equal(name, "pgbouncer");
  assert.equal(service.image, DEFAULT_IMAGE);
  assert.equal(service.ports, undefined, "not published by default");
  assert.deepEqual(service.depends_on, { postgres: { condition: "service_healthy" } });
  assert.deepEqual(service.healthcheck.test, ["CMD", "pg_isready", "-h", "127.0.0.1", "-p", "6432"]);
  assert.ok(service.volumes.every((v) => v.endsWith(":ro")));
  const y = renderCompose({ name: "db-pool", port: 7432, publish: "127.0.0.1:7432", dependsOn: [], tlsDir: "./tls", networks: ["backend"] });
  assert.match(y, /^services:\n {2}db-pool:\n/m);
  assert.match(y, /- "127\.0\.0\.1:7432:7432"/);
  assert.match(y, /- "\.\/tls:\/etc\/pgbouncer\/tls:ro"/);
  assert.match(y, /retries: 10/);
  assert.doesNotMatch(y, /depends_on/);
  code(() => composeService({ name: "Bad Name" }), "PGBOUNCER_BAD_CONFIG");
  code(() => composeService({ publish: "0.0.0.0:x" }), "PGBOUNCER_BAD_CONFIG");
  code(() => composeService({ configDir: "./a:b" }), "PGBOUNCER_BAD_CONFIG");
});

// ---- probe against fake servers ----------------------------------------------------------------

async function fakeServer(answer: (s: import("node:net").Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(answer);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) };
}
async function freePort(): Promise<number> {
  const s = await fakeServer((c) => c.destroy());
  await s.close();
  return s.port;
}

await check("probePgBouncer: N and S answers, wrong protocol, closed port, timeout", async () => {
  const seen: Buffer[] = [];
  const n = await fakeServer((s) => s.once("data", (b) => (seen.push(b), s.end("N"))));
  const r = await probePgBouncer({ port: n.port });
  assert.equal(r.ok, true);
  assert.equal(r.tls, false);
  assert.deepEqual([...seen[0]!], [0, 0, 0, 8, 4, 210, 22, 47]);
  await n.close();
  const s = await fakeServer((c) => c.once("data", () => c.end("S")));
  assert.equal((await probePgBouncer({ port: s.port })).tls, true);
  await s.close();
  const http = await fakeServer((c) => c.once("data", () => c.end("HTTP/1.1 400\r\n\r\n")));
  assert.deepEqual({ ...(await probePgBouncer({ port: http.port })), latencyMs: 0 }, { ok: false, tls: null, error: "not a PostgreSQL protocol answer", latencyMs: 0 });
  await http.close();
  assert.equal((await probePgBouncer({ port: await freePort() })).error, "ECONNREFUSED");
  const silent = await fakeServer((c) => void c.resume());
  const t = await probePgBouncer({ port: silent.port, timeoutMs: 100 });
  assert.equal(t.ok, false);
  assert.match(t.error!, /no answer within 100 ms/);
  await silent.close();
});

await check("waitForPgBouncer retries, then gives up with PGBOUNCER_UNREACHABLE", async () => {
  const port = await freePort();
  setTimeout(() => void fakeServer((c) => c.once("data", () => c.end("N"))).then((s) => setTimeout(() => void s.close(), 2000)), 150);
  // the fake server listens on a new port, so this one must time out
  await assert.rejects(waitForPgBouncer({ port, waitMs: 300, intervalMs: 50 }), (e: unknown) => e instanceof PgBouncerError && e.code === "PGBOUNCER_UNREACHABLE");
  const later = await fakeServer((c) => c.once("data", () => c.end("N")));
  const r = await waitForPgBouncer({ port: later.port, waitMs: 1000 });
  assert.equal(r.ok, true);
  await later.close();
});

await check("readiness: probe only, query ok, query failure and timeout summarised", async () => {
  const s = await fakeServer((c) => c.once("data", () => c.end("N")));
  assert.equal((await readiness({ port: s.port })()).ok, true);
  const good = await readiness({ port: s.port, query: async () => 1 })();
  assert.equal(good.query?.ok, true);
  const bad = await readiness({ port: s.port, query: async () => { throw new Error("password authentication failed\nDETAIL"); } })();
  assert.deepEqual([bad.ok, bad.query?.error], [false, "password authentication failed"]);
  const slow = await readiness({ port: s.port, queryTimeoutMs: 50, query: () => new Promise((r) => setTimeout(r, 500)) })();
  assert.match(slow.query!.error!, /longer than 50 ms/);
  await s.close();
  const down = await readiness({ port: await freePort(), query: async () => assert.fail("must not run") })();
  assert.deepEqual([down.ok, down.query], [false, undefined]);
});

// ---- real PostgreSQL + PgBouncer -------------------------------------------------------------

function findPgBin(): string | null {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const root = "/usr/lib/postgresql";
  if (!existsSync(root)) return null;
  const versions = readdirSync(root).filter((v) => existsSync(join(root, v, "bin", "postgres"))).sort((a, b) => Number(b) - Number(a));
  return versions[0] ? join(root, versions[0], "bin") : null;
}
function findPgBouncer(): string | null {
  if (process.env.PGBOUNCER_BIN) return process.env.PGBOUNCER_BIN;
  const r = spawnSync("sh", ["-c", "command -v pgbouncer || ls /usr/sbin/pgbouncer 2>/dev/null"], { encoding: "utf8" });
  return r.stdout.trim().split("\n")[0] || null;
}

const pgBin = findPgBin();
const bouncerBin = findPgBouncer();
const procs: ChildProcess[] = [];
let work = "";

if (!pgBin || !bouncerBin) {
  if (process.env.REQUIRE_PGBOUNCER === "1") failures.push(`✗ PostgreSQL (${pgBin ?? "missing"}) and PgBouncer (${bouncerBin ?? "missing"}) are required`);
  else {
    console.log("PostgreSQL or PgBouncer not found: skipping the integration checks (set PG_BIN / PGBOUNCER_BIN)");
    skipped++;
  }
} else {
  const asRoot = process.getuid?.() === 0;
  const runAs = process.env.PG_TEST_USER ?? "nobody";
  const ids = asRoot ? spawnSync("id", ["-u", runAs], { encoding: "utf8" }).stdout.trim() : "";
  const uid = Number(ids);
  const gid = asRoot ? Number(spawnSync("id", ["-g", runAs], { encoding: "utf8" }).stdout.trim()) : 0;
  const wrap = (cmd: string, args: string[]): [string, string[]] => (asRoot ? ["runuser", ["-u", runAs, "--", cmd, ...args]] : [cmd, args]);
  const own = (p: string) => asRoot && chownSync(p, uid, gid);
  const sh = (cmd: string, args: string[]) => {
    const [c, a] = wrap(cmd, args);
    const r = spawnSync(c, a, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  };
  const start = (cmd: string, args: string[], label: string) => {
    const [c, a] = wrap(cmd, args);
    const p = spawn(c, a, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    p.stdout!.on("data", (b) => (log += b));
    p.stderr!.on("data", (b) => (log += b));
    procs.push(p);
    return { proc: p, log: () => `${label}:\n${log}` };
  };

  work = mkdtempSync(join(tmpdir(), "pgbouncer-kit-"));
  chmodSync(work, 0o755);
  own(work);
  const pgData = join(work, "pgdata");
  const superPw = "super-" + Math.random().toString(36).slice(2);
  writeFileSync(join(work, "pw"), superPw);
  own(join(work, "pw"));
  const pgPort = await freePort();
  const bouncerPort = await freePort();
  const authPort = await freePort();
  const cliPort = await freePort();

  await check("integration: PostgreSQL starts with SCRAM", async () => {
    sh(join(pgBin, "initdb"), ["-D", pgData, "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${join(work, "pw")}`, "-E", "UTF8", "--no-instructions"]);
    start(join(pgBin, "postgres"), ["-D", pgData, "-p", String(pgPort), "-k", work, "-c", "listen_addresses=127.0.0.1"], "postgres");
    await waitForPgBouncer({ port: pgPort, waitMs: 20_000 });
  });

  const superClient = async (database = "postgres") => {
    for (let i = 0; ; i++) {
      const c = new pg.Client({ host: "127.0.0.1", port: pgPort, user: "postgres", password: superPw, database });
      try {
        await c.connect();
        return c;
      } catch (e) {
        await c.end().catch(() => undefined);
        if (i > 50) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  const appVerifier = scramVerifier("app-password");
  const authVerifier = scramVerifier("auth-password");

  await check("integration: our verifier equals PostgreSQL's for the same salt (ASCII and Unicode)", async () => {
    const c = await superClient();
    try {
      for (const pw of ["pencil", "pässwörd ⅨX", "a\u0007b"]) {
        await c.query(`DROP ROLE IF EXISTS probe; CREATE ROLE probe PASSWORD '${pw.replace(/'/g, "''")}'`);
        const { rows } = await c.query<{ rolpassword: string }>("SELECT rolpassword FROM pg_authid WHERE rolname = 'probe'");
        const server = rows[0]!.rolpassword;
        const parts = parseScramVerifier(server)!;
        assert.equal(scramVerifier(pw, { salt: parts.salt, iterations: parts.iterations }), server, `password ${JSON.stringify(pw)}`);
        assert.ok(verifyScram(pw, server));
      }
      await c.query("DROP ROLE probe");
      // set up the app and auth roles with verifiers made here
      await c.query(`CREATE ROLE app LOGIN; ${alterRoleSql("app", appVerifier)}`);
      await c.query("CREATE DATABASE mgpl OWNER app");
      await c.query("CREATE ROLE dynamic LOGIN PASSWORD 'dynamic-password'; GRANT CONNECT ON DATABASE mgpl TO dynamic");
      const { rows } = await c.query<{ rolpassword: string }>("SELECT rolpassword FROM pg_authid WHERE rolname = 'app'");
      assert.equal(rows[0]!.rolpassword, appVerifier, "PostgreSQL stores the pre-hashed verifier as it is");
    } finally {
      await c.end();
    }
    const m = await superClient("mgpl");
    try {
      await m.query(authQuerySetupSql("pgbouncer_auth"));
      await m.query(authQuerySetupSql("pgbouncer_auth")); // idempotent
      await m.query(alterRoleSql("pgbouncer_auth", authVerifier));
      await m.query("GRANT CONNECT ON DATABASE mgpl TO pgbouncer_auth");
    } finally {
      await m.end();
    }
  });

  const writeConfig = (dir: string, ini: string, users: string) => {
    writeFileSync(join(dir, "pgbouncer.ini"), ini);
    writeFileSync(join(dir, "userlist.txt"), users, { mode: 0o600 });
    own(join(dir, "pgbouncer.ini"));
    own(join(dir, "userlist.txt"));
  };
  const bouncerConfig = (port: number, file: string, auth: Record<string, string> = {}) =>
    renderIni({
      listenAddr: "127.0.0.1",
      listenPort: port,
      databases: [{ name: "mgpl", host: "127.0.0.1", port: pgPort }],
      auth: { file, ...auth },
      serverTls: { mode: "disable" },
      adminUsers: ["app"],
      extra: { unix_socket_dir: "" },
    });

  const connect = (port: number, user: string, password: string, database = "mgpl") =>
    new pg.Client({ host: "127.0.0.1", port, user, password, database, connectionTimeoutMillis: 5000 });

  await check("integration: PgBouncer with a SCRAM userlist passes through to PostgreSQL", async () => {
    const dir = mkdtempSync(join(work, "b1-"));
    chmodSync(dir, 0o755);
    own(dir);
    writeConfig(dir, bouncerConfig(bouncerPort, join(dir, "userlist.txt")), renderUserlist([{ user: "app", secret: appVerifier }]));
    const b = start(bouncerBin, [join(dir, "pgbouncer.ini")], "pgbouncer");
    try {
      await waitForPgBouncer({ port: bouncerPort, waitMs: 10_000 });
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${b.log()}`);
    }
    const c = connect(bouncerPort, "app", "app-password");
    await c.connect();
    try {
      assert.equal((await c.query("SELECT 1 AS one")).rows[0].one, 1);
      // transaction pooling: work inside a transaction stays on one server connection
      await c.query("BEGIN");
      await c.query("CREATE TEMP TABLE t (n int) ON COMMIT DROP");
      await c.query("INSERT INTO t VALUES (1), (2)");
      assert.equal((await c.query("SELECT count(*)::int AS n FROM t")).rows[0].n, 2);
      await c.query("COMMIT");
      // named protocol-level prepared statements (max_prepared_statements)
      for (let i = 0; i < 3; i++) {
        const r = await c.query({ name: "plus", text: "SELECT $1::int + 1 AS n", values: [i] });
        assert.equal(r.rows[0].n, i + 1);
      }
    } finally {
      await c.end();
    }
    const wrong = connect(bouncerPort, "app", "not-the-password");
    await assert.rejects(wrong.connect(), /password authentication failed|SASL/);
    await wrong.end().catch(() => undefined);
    // the admin console answers SHOW POOLS for admin_users
    const admin = connect(bouncerPort, "app", "app-password", "pgbouncer");
    await admin.connect();
    try {
      const pools = await admin.query<{ database: string }>({ text: "SHOW POOLS", queryMode: "simple" } as pg.QueryConfig);
      assert.ok(pools.rows.some((r) => r.database === "mgpl"));
      assert.equal(iniValue(bouncerConfig(1, "x"), "pool_mode"), "transaction");
    } finally {
      await admin.end();
    }
    const ready = await readiness({ port: bouncerPort, query: async () => {
      const q = connect(bouncerPort, "app", "app-password");
      await q.connect();
      try {
        return await q.query("SELECT 1");
      } finally {
        await q.end();
      }
    } })();
    assert.equal(ready.ok, true, JSON.stringify(ready));
  });

  await check("integration: auth_query finds users that are not in the userlist (never superusers)", async () => {
    const dir = mkdtempSync(join(work, "b2-"));
    chmodSync(dir, 0o755);
    own(dir);
    writeConfig(
      dir,
      bouncerConfig(authPort, join(dir, "userlist.txt"), { query: AUTH_QUERY, user: "pgbouncer_auth", dbname: "mgpl" }),
      renderUserlist([{ user: "pgbouncer_auth", secret: "auth-password", format: "plain" }]),
    );
    const b = start(bouncerBin, [join(dir, "pgbouncer.ini")], "pgbouncer auth_query");
    try {
      await waitForPgBouncer({ port: authPort, waitMs: 10_000 });
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${b.log()}`);
    }
    const c = connect(authPort, "dynamic", "dynamic-password");
    await c.connect();
    try {
      assert.equal((await c.query("SELECT current_user AS u")).rows[0].u, "dynamic");
    } finally {
      await c.end();
    }
    const su = connect(authPort, "postgres", superPw);
    await assert.rejects(su.connect());
    await su.end().catch(() => undefined);
  });

  await check("integration: the CLI renders files from PGBOUNCER_* variables that a real PgBouncer runs", async () => {
    const dir = mkdtempSync(join(work, "cli-"));
    chmodSync(dir, 0o755);
    own(dir);
    const out = join(dir, "conf");
    const env = {
      ...process.env,
      PGBOUNCER_UPSTREAM_URL: `postgres://127.0.0.1:${pgPort}/mgpl?sslmode=disable`,
      PGBOUNCER_USERS: `app:${appVerifier}`,
      PGBOUNCER_LISTEN_ADDR: "127.0.0.1",
      PGBOUNCER_LISTEN_PORT: String(cliPort),
      PGBOUNCER_AUTH_FILE: join(out, "userlist.txt"),
      PGBOUNCER_DEFAULT_POOL_SIZE: "4",
    };
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const r = spawnSync(tsx, ["src/cli.ts", "render", "--out", out], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /SCRAM|password/i, "prints paths, not secrets");
    assert.equal(statSync(join(out, "userlist.txt")).mode & 0o777, 0o600);
    const ini = readFileSync(join(out, "pgbouncer.ini"), "utf8");
    assert.equal(iniValue(ini, "default_pool_size"), "4");
    assert.equal(iniValue(ini, "server_tls_sslmode"), "disable");
    // the compose image's unix socket dir does not exist here
    writeFileSync(join(out, "pgbouncer.ini"), `${ini}\nunix_socket_dir =\n`);
    for (const f of ["", "pgbouncer.ini", "userlist.txt"]) own(join(out, f));
    const b = start(bouncerBin, [join(out, "pgbouncer.ini")], "pgbouncer cli");
    try {
      await waitForPgBouncer({ port: cliPort, waitMs: 10_000 });
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${b.log()}`);
    }
    const c = connect(cliPort, "app", "app-password");
    await c.connect();
    try {
      assert.equal((await c.query("SELECT current_database() AS d")).rows[0].d, "mgpl");
    } finally {
      await c.end();
    }
    const check = spawnSync(tsx, ["src/cli.ts", "check", "--port", String(cliPort)], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    const verifier = spawnSync(tsx, ["src/cli.ts", "verifier", "app"], { input: "app-password\n", encoding: "utf8" });
    const [v, sql] = verifier.stdout.trim().split("\n");
    assert.ok(verifyScram("app-password", v!));
    assert.equal(sql, alterRoleSql("app", v!));
    const bad = spawnSync(tsx, ["src/cli.ts", "render", "--out", join(dir, "x")], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /PGBOUNCER_BAD_ENV/);
  });
}

// ---- done ----------------------------------------------------------------------------------------

for (const p of procs) p.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 300));
if (work) rmSync(work, { recursive: true, force: true });

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed${skipped ? " (integration skipped)" : ""}`);
process.exit(0);
