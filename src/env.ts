import {
  AUTH_TYPES,
  defineConfig,
  POOL_MODES,
  TLS_MODES,
  type AuthType,
  type DatabaseTarget,
  type PgBouncerConfig,
  type PgBouncerConfigInput,
  type PoolMode,
  type TlsMode,
  type TlsSide,
} from "./config";
import { PgBouncerError } from "./errors";
import { parsePostgresUrl } from "./url";
import type { SecretFormat, UserEntry } from "./userlist";

export type Env = Record<string, string | undefined>;

/** Every variable `configFromEnv` and `usersFromEnv` read, with what it sets. */
export const ENV_VARS: Record<string, string> = {
  PGBOUNCER_UPSTREAM_URL: "PostgreSQL URL PgBouncer forwards to (host, port, database; user and password go to the userlist)",
  PGBOUNCER_DATABASES: "More upstreams, comma-separated: [name=]postgres://… (name defaults to the URL's database)",
  PGBOUNCER_USERS: "Extra users, comma-separated user:secret (SCRAM verifier, md5 secret, or a percent-encoded password)",
  PGBOUNCER_USER_SECRET: "How plain passwords are stored: scram (default) | md5 | plain",
  PGBOUNCER_LISTEN_ADDR: "listen_addr (0.0.0.0)",
  PGBOUNCER_LISTEN_PORT: "listen_port (6432)",
  PGBOUNCER_POOL_MODE: "pool_mode: session | transaction (default) | statement",
  PGBOUNCER_MAX_CLIENT_CONN: "max_client_conn (500)",
  PGBOUNCER_DEFAULT_POOL_SIZE: "default_pool_size (20)",
  PGBOUNCER_MIN_POOL_SIZE: "min_pool_size (0)",
  PGBOUNCER_RESERVE_POOL_SIZE: "reserve_pool_size (5)",
  PGBOUNCER_RESERVE_POOL_TIMEOUT: "reserve_pool_timeout in seconds (3)",
  PGBOUNCER_MAX_DB_CONNECTIONS: "max_db_connections (0 = no cap)",
  PGBOUNCER_MAX_PREPARED_STATEMENTS: "max_prepared_statements (200; 0 = off)",
  PGBOUNCER_SERVER_LIFETIME: "server_lifetime in seconds (3600)",
  PGBOUNCER_SERVER_IDLE_TIMEOUT: "server_idle_timeout in seconds (600)",
  PGBOUNCER_SERVER_CONNECT_TIMEOUT: "server_connect_timeout in seconds (15)",
  PGBOUNCER_QUERY_WAIT_TIMEOUT: "query_wait_timeout in seconds (120)",
  PGBOUNCER_CLIENT_IDLE_TIMEOUT: "client_idle_timeout in seconds (0 = off)",
  PGBOUNCER_IDLE_TRANSACTION_TIMEOUT: "idle_transaction_timeout in seconds (0 = off)",
  PGBOUNCER_AUTH_TYPE: "auth_type: scram-sha-256 (default) | md5 | plain | cert | hba",
  PGBOUNCER_AUTH_FILE: "auth_file (/etc/pgbouncer/userlist.txt)",
  PGBOUNCER_AUTH_QUERY: "auth_query (see AUTH_QUERY and authQuerySetupSql)",
  PGBOUNCER_AUTH_USER: "auth_user",
  PGBOUNCER_AUTH_PASSWORD: "Password of PGBOUNCER_AUTH_USER, written to the userlist in plain text (PgBouncer logs in as it)",
  PGBOUNCER_AUTH_DBNAME: "auth_dbname",
  PGBOUNCER_AUTH_HBA_FILE: "auth_hba_file (auth_type hba)",
  PGBOUNCER_ADMIN_USERS: "admin_users, comma-separated",
  PGBOUNCER_STATS_USERS: "stats_users, comma-separated",
  PGBOUNCER_IGNORE_STARTUP_PARAMETERS: "ignore_startup_parameters, comma-separated (extra_float_digits)",
  PGBOUNCER_LOG_CONNECTIONS: "log_connections and log_disconnections: true | false (false)",
  PGBOUNCER_CLIENT_TLS_SSLMODE: "client_tls_sslmode, apps → PgBouncer (disable)",
  PGBOUNCER_CLIENT_TLS_CERT_FILE: "client_tls_cert_file",
  PGBOUNCER_CLIENT_TLS_KEY_FILE: "client_tls_key_file",
  PGBOUNCER_CLIENT_TLS_CA_FILE: "client_tls_ca_file",
  PGBOUNCER_CLIENT_TLS_PROTOCOLS: "client_tls_protocols",
  PGBOUNCER_CLIENT_TLS_CIPHERS: "client_tls_ciphers",
  PGBOUNCER_SERVER_TLS_SSLMODE: "server_tls_sslmode, PgBouncer → PostgreSQL (the upstream URL's sslmode, else prefer)",
  PGBOUNCER_SERVER_TLS_CERT_FILE: "server_tls_cert_file (client certificate for PostgreSQL)",
  PGBOUNCER_SERVER_TLS_KEY_FILE: "server_tls_key_file",
  PGBOUNCER_SERVER_TLS_CA_FILE: "server_tls_ca_file (the upstream URL's sslrootcert, if any)",
  PGBOUNCER_SERVER_TLS_PROTOCOLS: "server_tls_protocols",
  PGBOUNCER_SERVER_TLS_CIPHERS: "server_tls_ciphers",
};

interface Upstream {
  name: string;
  url: string;
}

function upstreams(env: Env, problems: string[]): Upstream[] {
  const out: Upstream[] = [];
  const add = (raw: string, from: string) => {
    const m = /^([A-Za-z0-9_.$-]+)=(postgres(?:ql)?:\/\/.*)$/.exec(raw);
    const url = m ? m[2]! : raw;
    try {
      const parsed = parsePostgresUrl(url);
      out.push({ name: m ? m[1]! : parsed.database, url });
    } catch (e) {
      problems.push(`${from}: ${(e as Error).message}`);
    }
  };
  if (env.PGBOUNCER_UPSTREAM_URL?.trim()) add(env.PGBOUNCER_UPSTREAM_URL.trim(), "PGBOUNCER_UPSTREAM_URL");
  for (const item of list(env.PGBOUNCER_DATABASES)) add(item, "PGBOUNCER_DATABASES");
  return out;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Builds the configuration from environment variables (see `ENV_VARS`), on top of `base` and
 * the defaults. Throws `PGBOUNCER_BAD_ENV` (bad variables) or `PGBOUNCER_BAD_CONFIG`, listing every problem.
 */
export function configFromEnv(env: Env = process.env, base: Partial<PgBouncerConfigInput> = {}): PgBouncerConfig {
  const problems: string[] = [];
  const get = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = get(k);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) {
      problems.push(`${k} must be a whole number`);
      return undefined;
    }
    return Number(v);
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
    const v = get(k);
    if (v === undefined) return undefined;
    if (!allowed.includes(v as T)) {
      problems.push(`${k} must be one of ${allowed.join(", ")}`);
      return undefined;
    }
    return v as T;
  };
  const flag = (k: string): boolean | undefined => {
    const v = get(k)?.toLowerCase();
    if (v === undefined) return undefined;
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
    problems.push(`${k} must be true or false`);
    return undefined;
  };

  const ups = upstreams(env, problems);
  const databases: DatabaseTarget[] = ups.map((u) => {
    const p = parsePostgresUrl(u.url);
    return { name: u.name, host: p.host, port: p.port, ...(p.database !== u.name ? { dbname: p.database } : {}) };
  });
  if (!env.PGBOUNCER_UPSTREAM_URL?.trim() && !list(env.PGBOUNCER_DATABASES).length && !base.databases?.length) problems.push("PGBOUNCER_UPSTREAM_URL (or PGBOUNCER_DATABASES) is required");

  // The first upstream's sslmode / sslrootcert describe PgBouncer → PostgreSQL.
  const first = ups[0] ? parsePostgresUrl(ups[0].url).params : {};
  const urlMode = first.sslmode as TlsMode | undefined;
  if (urlMode !== undefined && !TLS_MODES.includes(urlMode)) problems.push(`sslmode in the upstream URL must be one of ${TLS_MODES.join(", ")}`);

  const tls = (side: "CLIENT" | "SERVER", fallback: Partial<TlsSide>): Partial<TlsSide> => {
    const pre = `PGBOUNCER_${side}_TLS_`;
    const t: Partial<TlsSide> = { ...fallback };
    const mode = oneOf<TlsMode>(`${pre}SSLMODE`, TLS_MODES);
    if (mode) t.mode = mode;
    const files = { certFile: "CERT_FILE", keyFile: "KEY_FILE", caFile: "CA_FILE", protocols: "PROTOCOLS", ciphers: "CIPHERS" } as const;
    for (const [key, suffix] of Object.entries(files) as [keyof typeof files, string][]) {
      const v = get(pre + suffix);
      if (v !== undefined) t[key] = v;
    }
    return t;
  };

  const auth = {
    ...base.auth,
    ...defined({
      type: oneOf<AuthType>("PGBOUNCER_AUTH_TYPE", AUTH_TYPES),
      file: get("PGBOUNCER_AUTH_FILE"),
      query: get("PGBOUNCER_AUTH_QUERY"),
      user: get("PGBOUNCER_AUTH_USER"),
      dbname: get("PGBOUNCER_AUTH_DBNAME"),
      hbaFile: get("PGBOUNCER_AUTH_HBA_FILE"),
    }),
  };
  const input: PgBouncerConfigInput = {
    ...base,
    databases: databases.length ? databases : base.databases ?? [],
    ...defined({
      listenAddr: get("PGBOUNCER_LISTEN_ADDR"),
      listenPort: num("PGBOUNCER_LISTEN_PORT"),
      poolMode: oneOf<PoolMode>("PGBOUNCER_POOL_MODE", POOL_MODES),
      maxClientConn: num("PGBOUNCER_MAX_CLIENT_CONN"),
      defaultPoolSize: num("PGBOUNCER_DEFAULT_POOL_SIZE"),
      minPoolSize: num("PGBOUNCER_MIN_POOL_SIZE"),
      reservePoolSize: num("PGBOUNCER_RESERVE_POOL_SIZE"),
      reservePoolTimeout: num("PGBOUNCER_RESERVE_POOL_TIMEOUT"),
      maxDbConnections: num("PGBOUNCER_MAX_DB_CONNECTIONS"),
      maxPreparedStatements: num("PGBOUNCER_MAX_PREPARED_STATEMENTS"),
      serverLifetime: num("PGBOUNCER_SERVER_LIFETIME"),
      serverIdleTimeout: num("PGBOUNCER_SERVER_IDLE_TIMEOUT"),
      serverConnectTimeout: num("PGBOUNCER_SERVER_CONNECT_TIMEOUT"),
      queryWaitTimeout: num("PGBOUNCER_QUERY_WAIT_TIMEOUT"),
      clientIdleTimeout: num("PGBOUNCER_CLIENT_IDLE_TIMEOUT"),
      idleTransactionTimeout: num("PGBOUNCER_IDLE_TRANSACTION_TIMEOUT"),
      adminUsers: env.PGBOUNCER_ADMIN_USERS !== undefined ? list(env.PGBOUNCER_ADMIN_USERS) : undefined,
      statsUsers: env.PGBOUNCER_STATS_USERS !== undefined ? list(env.PGBOUNCER_STATS_USERS) : undefined,
      ignoreStartupParameters:
        env.PGBOUNCER_IGNORE_STARTUP_PARAMETERS !== undefined ? list(env.PGBOUNCER_IGNORE_STARTUP_PARAMETERS) : undefined,
      logConnections: flag("PGBOUNCER_LOG_CONNECTIONS"),
    }),
    auth,
    clientTls: tls("CLIENT", base.clientTls ?? {}),
    serverTls: tls("SERVER", {
      ...base.serverTls,
      ...defined({ mode: TLS_MODES.includes(urlMode as TlsMode) ? urlMode : undefined, caFile: first.sslrootcert }),
    }),
  };
  if (problems.length) throw new PgBouncerError("PGBOUNCER_BAD_ENV", `Invalid PgBouncer environment:\n- ${problems.join("\n- ")}`, problems);
  return defineConfig(input);
}

/**
 * The userlist entries from the environment: the user and password of every upstream URL, then
 * `PGBOUNCER_USERS`. Pass them to `renderUserlist(entries, secretFormatFromEnv(env))`.
 */
export function usersFromEnv(env: Env = process.env): UserEntry[] {
  const problems: string[] = [];
  const byUser = new Map<string, string>();
  for (const u of upstreams(env, problems)) {
    const p = parsePostgresUrl(u.url);
    if (p.user && p.password && !byUser.has(p.user)) byUser.set(p.user, p.password);
  }
  for (const item of list(env.PGBOUNCER_USERS)) {
    const i = item.indexOf(":");
    if (i <= 0 || i === item.length - 1) {
      problems.push("PGBOUNCER_USERS entries are user:secret");
      continue;
    }
    const user = item.slice(0, i);
    let secret = item.slice(i + 1);
    if (!secret.startsWith("SCRAM-SHA-256$") && !/^md5[0-9a-f]{32}$/.test(secret)) {
      try {
        secret = decodeURIComponent(secret);
      } catch {
        problems.push(`PGBOUNCER_USERS: the password of ${user} is not valid percent-encoding`);
        continue;
      }
    }
    byUser.set(user, secret);
  }
  const authUser = env.PGBOUNCER_AUTH_USER?.trim();
  const authPassword = env.PGBOUNCER_AUTH_PASSWORD;
  if (authPassword && !authUser) problems.push("PGBOUNCER_AUTH_PASSWORD needs PGBOUNCER_AUTH_USER");
  if (problems.length) throw new PgBouncerError("PGBOUNCER_BAD_ENV", `Invalid PgBouncer environment:\n- ${problems.join("\n- ")}`, problems);
  const entries: UserEntry[] = [...byUser].filter(([user]) => !(authPassword && user === authUser)).map(([user, secret]) => ({ user, secret }));
  if (authUser && authPassword) entries.push({ user: authUser, secret: authPassword, format: "plain" });
  return entries;
}

/** `PGBOUNCER_USER_SECRET`: scram (default), md5 or plain. */
export function secretFormatFromEnv(env: Env = process.env): SecretFormat {
  const v = env.PGBOUNCER_USER_SECRET?.trim() || "scram";
  if (v !== "scram" && v !== "md5" && v !== "plain") {
    throw new PgBouncerError("PGBOUNCER_BAD_ENV", "PGBOUNCER_USER_SECRET must be one of scram, md5, plain", ["PGBOUNCER_USER_SECRET must be one of scram, md5, plain"]);
  }
  return v;
}

function defined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
