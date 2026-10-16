import { PgBouncerError } from "./errors";

/** A PostgreSQL connection URL, decoded. */
export interface PostgresUrl {
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  /** Query parameters (`sslmode`, `application_name`, …), decoded. */
  params: Record<string, string>;
}

const SCHEMES = new Set(["postgres:", "postgresql:"]);

/** Parses `postgres://user:password@host:port/database?params`. Throws `PGBOUNCER_BAD_URL`. */
export function parsePostgresUrl(url: string): PostgresUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PgBouncerError("PGBOUNCER_BAD_URL", "Not a valid PostgreSQL URL");
  }
  if (!SCHEMES.has(u.protocol)) throw new PgBouncerError("PGBOUNCER_BAD_URL", "A PostgreSQL URL starts with postgres:// or postgresql://");
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) throw new PgBouncerError("PGBOUNCER_BAD_URL", "The PostgreSQL URL has no host");
  const port = u.port ? Number(u.port) : 5432;
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const params: Record<string, string> = {};
  u.searchParams.forEach((v, k) => (params[k] = v));
  return {
    host,
    port,
    database: database || (u.username ? decodeURIComponent(u.username) : "postgres"),
    ...(u.username ? { user: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    params,
  };
}

export interface PgBouncerUrlOptions {
  /** PgBouncer's host as the app sees it (compose service name, `127.0.0.1`, …). */
  host: string;
  /** Default 6432. */
  port?: number;
  /** The database name in PgBouncer's [databases] section, when it differs from the upstream one. */
  database?: string;
}

/**
 * The app's DATABASE_URL rewritten to go through PgBouncer: same user, password and parameters,
 * PgBouncer's host and port. `sslmode` is kept, because it now describes app → PgBouncer.
 */
export function pgbouncerUrl(databaseUrl: string, opts: PgBouncerUrlOptions): string {
  const parsed = parsePostgresUrl(databaseUrl);
  const u = new URL(databaseUrl);
  u.hostname = opts.host.includes(":") && !opts.host.startsWith("[") ? `[${opts.host}]` : opts.host;
  u.port = String(opts.port ?? 6432);
  u.pathname = `/${encodeURIComponent(opts.database ?? parsed.database)}`;
  return u.toString();
}
