import { PgBouncerError } from "./errors";

export type PoolMode = "session" | "transaction" | "statement";
/** `trust` and `any` are accepted by PgBouncer but refused here: every client must authenticate. */
export type AuthType = "scram-sha-256" | "md5" | "plain" | "cert" | "hba";
export type TlsMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";

/** One entry of the [databases] section: a name clients connect to, and where it really lives. */
export interface DatabaseTarget {
  /** The name clients put in their URL. `*` is the fallback for any name. */
  name: string;
  host: string;
  /** Default 5432. */
  port?: number;
  /** The database on the server; default: `name` (or the client's name for `*`). */
  dbname?: string;
  /**
   * Forces the server-side user. Leave it out so PgBouncer logs in as the client's user (the
   * default, and what SCRAM pass-through needs). Never put a password here: passwords live in the userlist.
   */
  user?: string;
  /** Overrides the global `poolMode` for this database. */
  poolMode?: PoolMode;
  /** Overrides `defaultPoolSize`. */
  poolSize?: number;
  /** Overrides `minPoolSize`. */
  minPoolSize?: number;
  /** Overrides `reservePoolSize`. */
  reservePoolSize?: number;
  /** Overrides `maxDbConnections`. */
  maxDbConnections?: number;
  /** `auth_user` for this database's `auth_query`. */
  authUser?: string;
}

/** TLS for one side: `client` = apps → PgBouncer, `server` = PgBouncer → PostgreSQL. */
export interface TlsSide {
  mode: TlsMode;
  certFile?: string;
  keyFile?: string;
  caFile?: string;
  /** PgBouncer's `*_tls_protocols`, e.g. `"secure"` (TLS 1.2 + 1.3, PgBouncer's default) or `"tlsv1.3"`. */
  protocols?: string;
  /** OpenSSL cipher list; PgBouncer's default (`fast`) when left out. */
  ciphers?: string;
}

export interface AuthConfig {
  /** Default `scram-sha-256`. */
  type: AuthType;
  /** Default `/etc/pgbouncer/userlist.txt`. */
  file: string;
  /**
   * Looks users up in PostgreSQL instead of (or besides) the userlist, as `authUser`.
   * `authQuerySetupSql()` creates a safe lookup function for it.
   */
  query?: string;
  /** The user `query` runs as. It must itself be in the userlist. */
  user?: string;
  /** Database `query` runs in (PgBouncer ≥ 1.20); default: the database the client asked for. */
  dbname?: string;
  /** `hba` auth only: path of the pg_hba-style file. */
  hbaFile?: string;
}

export interface PgBouncerConfig {
  /** Default `0.0.0.0` (inside a container network). Use `127.0.0.1` on a shared host. */
  listenAddr: string;
  /** Default 6432. */
  listenPort: number;
  databases: DatabaseTarget[];
  /**
   * Default `transaction`: a server connection is held only during a transaction. Clients must not
   * rely on session state (`SET` outside a transaction, session advisory locks, `LISTEN`, temp
   * tables across transactions). db-kit's PostgreSQL backend is transaction-safe.
   */
  poolMode: PoolMode;
  /** Default 500. */
  maxClientConn: number;
  /** Server connections per user+database pair. Default 20. */
  defaultPoolSize: number;
  /** Default 0. */
  minPoolSize: number;
  /** Extra connections allowed when a client waits longer than `reservePoolTimeout`. Default 5. */
  reservePoolSize: number;
  /** Seconds. Default 3. */
  reservePoolTimeout: number;
  /** Cap per database across users; 0 = no cap (PgBouncer's default). Default 0. */
  maxDbConnections: number;
  /** Protocol-level prepared statements in transaction mode (PgBouncer ≥ 1.21). 0 = off. Default 200. */
  maxPreparedStatements: number;
  auth: AuthConfig;
  /** May run admin commands on the `pgbouncer` console. Default none. */
  adminUsers: string[];
  /** May run read-only `SHOW` commands on the console. Default none. */
  statsUsers: string[];
  /** Default `DISCARD ALL` (used in session mode). */
  serverResetQuery: string;
  /** Seconds. Default 3600. */
  serverLifetime: number;
  /** Seconds. Default 600. */
  serverIdleTimeout: number;
  /** Seconds. Default 15. */
  serverConnectTimeout: number;
  /** Seconds a client may wait for a server connection. Default 120. */
  queryWaitTimeout: number;
  /** Seconds; 0 = off. Default 0. */
  clientIdleTimeout: number;
  /** Seconds a server connection may sit idle inside a transaction; 0 = off. Default 0. */
  idleTransactionTimeout: number;
  /** Startup parameters PgBouncer ignores instead of refusing. Default `extra_float_digits`. */
  ignoreStartupParameters: string[];
  /** Default false: connections and disconnections are not logged (busy pools are noisy). */
  logConnections: boolean;
  /** Default true. */
  logPoolerErrors: boolean;
  /** Default `{ mode: "disable" }`: apps reach PgBouncer over the private network. */
  clientTls: TlsSide;
  /** Default `{ mode: "prefer" }` (PgBouncer's default). Use `verify-full` for managed PostgreSQL. */
  serverTls: TlsSide;
  /** Any other [pgbouncer] setting, written last. Keys are checked; values are written as they are. */
  extra: Record<string, string | number | boolean>;
}

export type PgBouncerConfigInput = Partial<Omit<PgBouncerConfig, "auth" | "clientTls" | "serverTls">> & {
  databases: DatabaseTarget[];
  auth?: Partial<AuthConfig>;
  clientTls?: Partial<TlsSide>;
  serverTls?: Partial<TlsSide>;
};

export const DEFAULT_CONFIG: Omit<PgBouncerConfig, "databases"> = {
  listenAddr: "0.0.0.0",
  listenPort: 6432,
  poolMode: "transaction",
  maxClientConn: 500,
  defaultPoolSize: 20,
  minPoolSize: 0,
  reservePoolSize: 5,
  reservePoolTimeout: 3,
  maxDbConnections: 0,
  maxPreparedStatements: 200,
  auth: { type: "scram-sha-256", file: "/etc/pgbouncer/userlist.txt" },
  adminUsers: [],
  statsUsers: [],
  serverResetQuery: "DISCARD ALL",
  serverLifetime: 3600,
  serverIdleTimeout: 600,
  serverConnectTimeout: 15,
  queryWaitTimeout: 120,
  clientIdleTimeout: 0,
  idleTransactionTimeout: 0,
  ignoreStartupParameters: ["extra_float_digits"],
  logConnections: false,
  logPoolerErrors: true,
  clientTls: { mode: "disable" },
  serverTls: { mode: "prefer" },
  extra: {},
};

export const POOL_MODES: readonly PoolMode[] = ["session", "transaction", "statement"];
export const AUTH_TYPES: readonly AuthType[] = ["scram-sha-256", "md5", "plain", "cert", "hba"];
export const TLS_MODES: readonly TlsMode[] = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];

/** Database names, user names and setting keys: no spaces, quotes, `=` or control characters. */
const NAME = /^[A-Za-z0-9_.$-]{1,63}$/;
const KEY = /^[a-z_][a-z0-9_]*$/;
/** Settings this kit writes itself; `extra` may not repeat them. */
const OWN_KEYS = new Set([
  "listen_addr", "listen_port", "pool_mode", "max_client_conn", "default_pool_size", "min_pool_size",
  "reserve_pool_size", "reserve_pool_timeout", "max_db_connections", "max_prepared_statements", "auth_type",
  "auth_file", "auth_query", "auth_user", "auth_dbname", "auth_hba_file", "admin_users", "stats_users", "server_reset_query",
  "server_lifetime", "server_idle_timeout", "server_connect_timeout", "query_wait_timeout", "client_idle_timeout",
  "idle_transaction_timeout", "ignore_startup_parameters", "log_connections", "log_disconnections",
  "log_pooler_errors",
]);

/** A value written into the ini file: one line, no control characters, no surrounding spaces. */
export function safeValue(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(v) && v === v.trim();
}

/** Fills defaults and checks everything; throws `PGBOUNCER_BAD_CONFIG` listing every problem. */
export function defineConfig(input: PgBouncerConfigInput): PgBouncerConfig {
  const config: PgBouncerConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    databases: input.databases,
    auth: { ...DEFAULT_CONFIG.auth, ...input.auth },
    clientTls: { ...DEFAULT_CONFIG.clientTls, ...input.clientTls },
    serverTls: { ...DEFAULT_CONFIG.serverTls, ...input.serverTls },
    adminUsers: [...(input.adminUsers ?? DEFAULT_CONFIG.adminUsers)],
    statsUsers: [...(input.statsUsers ?? DEFAULT_CONFIG.statsUsers)],
    ignoreStartupParameters: [...(input.ignoreStartupParameters ?? DEFAULT_CONFIG.ignoreStartupParameters)],
    extra: { ...(input.extra ?? {}) },
  };
  const problems = checkConfig(config);
  if (problems.length) {
    throw new PgBouncerError("PGBOUNCER_BAD_CONFIG", `Invalid PgBouncer configuration:\n- ${problems.join("\n- ")}`, problems);
  }
  return config;
}

function checkConfig(c: PgBouncerConfig): string[] {
  const p: string[] = [];
  const int = (name: string, v: unknown, min: number, max = 1_000_000) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) p.push(`${name} must be a whole number from ${min} to ${max}`);
  };
  const str = (name: string, v: unknown) => {
    if (typeof v !== "string" || !v || !safeValue(v)) p.push(`${name} must be a non-empty single-line value`);
  };
  const name = (label: string, v: unknown) => {
    if (typeof v !== "string" || !NAME.test(v)) p.push(`${label} must be 1-63 letters, digits, _ . $ or -`);
  };

  str("listenAddr", c.listenAddr);
  if (typeof c.listenAddr === "string" && /[\s;]/.test(c.listenAddr.replace(/,\s*/g, ","))) p.push("listenAddr must be addresses separated by commas");
  int("listenPort", c.listenPort, 1, 65535);
  if (!POOL_MODES.includes(c.poolMode)) p.push(`poolMode must be one of ${POOL_MODES.join(", ")}`);
  int("maxClientConn", c.maxClientConn, 1);
  int("defaultPoolSize", c.defaultPoolSize, 1, 10_000);
  int("minPoolSize", c.minPoolSize, 0, 10_000);
  int("reservePoolSize", c.reservePoolSize, 0, 10_000);
  int("reservePoolTimeout", c.reservePoolTimeout, 0, 3600);
  int("maxDbConnections", c.maxDbConnections, 0, 100_000);
  int("maxPreparedStatements", c.maxPreparedStatements, 0, 100_000);
  int("serverLifetime", c.serverLifetime, 0, 604_800);
  int("serverIdleTimeout", c.serverIdleTimeout, 0, 604_800);
  int("serverConnectTimeout", c.serverConnectTimeout, 1, 3600);
  int("queryWaitTimeout", c.queryWaitTimeout, 0, 86_400);
  int("clientIdleTimeout", c.clientIdleTimeout, 0, 604_800);
  int("idleTransactionTimeout", c.idleTransactionTimeout, 0, 604_800);
  if (typeof c.minPoolSize === "number" && typeof c.defaultPoolSize === "number" && c.minPoolSize > c.defaultPoolSize) {
    p.push("minPoolSize cannot be larger than defaultPoolSize");
  }
  str("serverResetQuery", c.serverResetQuery);
  if (typeof c.logConnections !== "boolean") p.push("logConnections must be true or false");
  if (typeof c.logPoolerErrors !== "boolean") p.push("logPoolerErrors must be true or false");

  // auth
  const a = c.auth;
  if (!AUTH_TYPES.includes(a.type)) p.push(`auth.type must be one of ${AUTH_TYPES.join(", ")} (trust and any are not allowed)`);
  str("auth.file", a.file);
  if (a.query !== undefined) str("auth.query", a.query);
  if (a.user !== undefined) name("auth.user", a.user);
  if (a.dbname !== undefined) name("auth.dbname", a.dbname);
  if (a.query && !a.user && !c.databases.some((d) => d.authUser)) p.push("auth.query needs auth.user (or authUser on each database)");
  if (a.type === "hba") {
    if (!a.hbaFile) p.push("auth.type hba needs auth.hbaFile");
  }
  if (a.hbaFile !== undefined) str("auth.hbaFile", a.hbaFile);
  if (a.type === "cert" && c.clientTls.mode === "disable") p.push("auth.type cert needs clientTls");

  // users
  for (const [label, list] of [["adminUsers", c.adminUsers], ["statsUsers", c.statsUsers]] as const) {
    if (!Array.isArray(list)) p.push(`${label} must be a list`);
    else list.forEach((u, i) => name(`${label}[${i}]`, u));
  }
  if (!Array.isArray(c.ignoreStartupParameters)) p.push("ignoreStartupParameters must be a list");
  else c.ignoreStartupParameters.forEach((k, i) => {
    if (typeof k !== "string" || !KEY.test(k)) p.push(`ignoreStartupParameters[${i}] must be a parameter name`);
  });

  // databases
  if (!Array.isArray(c.databases) || c.databases.length === 0) p.push("databases needs at least one entry");
  else {
    const seen = new Set<string>();
    c.databases.forEach((d, i) => {
      const at = `databases[${i}]`;
      if (d.name !== "*") name(`${at}.name`, d.name);
      if (seen.has(d.name)) p.push(`${at}.name "${d.name}" is listed twice`);
      seen.add(d.name);
      if (d.name === "pgbouncer") p.push(`${at}.name "pgbouncer" is reserved for the admin console`);
      str(`${at}.host`, d.host);
      if (typeof d.host === "string" && /[\s'"\\=]/.test(d.host)) p.push(`${at}.host must not contain spaces, quotes, \\ or =`);
      if (d.port !== undefined) int(`${at}.port`, d.port, 1, 65535);
      if (d.dbname !== undefined) name(`${at}.dbname`, d.dbname);
      if (d.user !== undefined) name(`${at}.user`, d.user);
      if (d.authUser !== undefined) name(`${at}.authUser`, d.authUser);
      if (d.poolMode !== undefined && !POOL_MODES.includes(d.poolMode)) p.push(`${at}.poolMode must be one of ${POOL_MODES.join(", ")}`);
      if (d.poolSize !== undefined) int(`${at}.poolSize`, d.poolSize, 1, 10_000);
      if (d.minPoolSize !== undefined) int(`${at}.minPoolSize`, d.minPoolSize, 0, 10_000);
      if (d.reservePoolSize !== undefined) int(`${at}.reservePoolSize`, d.reservePoolSize, 0, 10_000);
      if (d.maxDbConnections !== undefined) int(`${at}.maxDbConnections`, d.maxDbConnections, 0, 100_000);
      if ("password" in (d as object)) p.push(`${at} must not carry a password (passwords belong in the userlist)`);
    });
  }

  // TLS
  for (const [side, t] of [["clientTls", c.clientTls], ["serverTls", c.serverTls]] as const) {
    if (!TLS_MODES.includes(t.mode)) p.push(`${side}.mode must be one of ${TLS_MODES.join(", ")}`);
    for (const k of ["certFile", "keyFile", "caFile", "protocols", "ciphers"] as const) if (t[k] !== undefined) str(`${side}.${k}`, t[k]);
    if ((t.certFile === undefined) !== (t.keyFile === undefined)) p.push(`${side}.certFile and ${side}.keyFile go together`);
  }
  if (c.clientTls.mode !== "disable" && (!c.clientTls.certFile || !c.clientTls.keyFile)) {
    p.push("clientTls needs certFile and keyFile unless its mode is disable");
  }
  for (const [side, t] of [["clientTls", c.clientTls], ["serverTls", c.serverTls]] as const) {
    if ((t.mode === "verify-ca" || t.mode === "verify-full") && !t.caFile) p.push(`${side}.mode ${t.mode} needs ${side}.caFile`);
  }

  // extra
  for (const [k, v] of Object.entries(c.extra ?? {})) {
    if (!KEY.test(k)) p.push(`extra key "${k}" is not a setting name`);
    else if (OWN_KEYS.has(k) || /^(client|server)_tls_/.test(k)) p.push(`extra.${k} is set by its own option; use that instead`);
    if (typeof v === "string" ? !safeValue(v) : typeof v !== "number" && typeof v !== "boolean") p.push(`extra.${k} must be a single-line string, a number or a boolean`);
  }
  return p;
}
