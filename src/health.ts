import { connect } from "node:net";
import { PgBouncerError } from "./errors";

export interface ProbeOptions {
  /** Default `127.0.0.1`. */
  host?: string;
  /** Default 6432. */
  port?: number;
  /** Default 2000 ms. */
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  /** The server accepted TLS (`S`) or declined it (`N`); `null` when the probe failed. */
  tls: boolean | null;
  latencyMs: number;
  /** Why it failed (no credentials, host names or addresses beyond what you passed). */
  error?: string;
}

/** The PostgreSQL SSLRequest packet: length 8, code 80877103. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

/**
 * Is PgBouncer (or PostgreSQL) up and speaking the protocol? Opens a TCP connection, sends an
 * SSLRequest and reads the one-byte answer, then closes. No credentials, no query, no pool slot used.
 */
export function probePgBouncer(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 6432;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const started = performance.now();
  return new Promise((resolve) => {
    let done = false;
    const socket = connect({ host, port });
    const finish = (r: Omit<ProbeResult, "latencyMs">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...r, latencyMs: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish({ ok: false, tls: null, error: `no answer within ${timeoutMs} ms` }), timeoutMs);
    socket.once("connect", () => socket.write(SSL_REQUEST));
    socket.once("data", (b) => {
      const c = String.fromCharCode(b[0] ?? 0);
      if (c === "S" || c === "N") finish({ ok: true, tls: c === "S" });
      else finish({ ok: false, tls: null, error: "not a PostgreSQL protocol answer" });
    });
    socket.once("error", (e: NodeJS.ErrnoException) => finish({ ok: false, tls: null, error: e.code ?? "connection failed" }));
    socket.once("close", () => finish({ ok: false, tls: null, error: "connection closed" }));
  });
}

export interface WaitOptions extends ProbeOptions {
  /** Total time to wait. Default 30 000 ms. */
  waitMs?: number;
  /** Pause between probes. Default 500 ms. */
  intervalMs?: number;
}

/** Probes until PgBouncer answers; throws `PGBOUNCER_UNREACHABLE` after `waitMs`. For start-up scripts. */
export async function waitForPgBouncer(opts: WaitOptions = {}): Promise<ProbeResult> {
  const end = Date.now() + (opts.waitMs ?? 30_000);
  let last: ProbeResult;
  for (;;) {
    last = await probePgBouncer(opts);
    if (last.ok) return last;
    if (Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 500));
  }
  throw new PgBouncerError(
    "PGBOUNCER_UNREACHABLE",
    `PgBouncer at ${opts.host ?? "127.0.0.1"}:${opts.port ?? 6432} did not answer (${last.error ?? "unknown"})`,
  );
}

export interface ReadinessOptions extends ProbeOptions {
  /**
   * Optional end-to-end check through the pool, with your own driver, e.g.
   * `() => sequelize.query("SELECT 1")`. Without it only the protocol probe runs.
   */
  query?: () => Promise<unknown>;
  /** Default 3000 ms for the query. */
  queryTimeoutMs?: number;
}

export interface Readiness {
  ok: boolean;
  pgbouncer: ProbeResult;
  query?: { ok: boolean; latencyMs: number; error?: string };
}

/**
 * A readiness check for a health endpoint (`GET /health`, a Kubernetes readiness probe, compose
 * `depends_on`). Framework-agnostic: call it and send the result. Errors are summarised, never thrown.
 */
export function readiness(opts: ReadinessOptions = {}): () => Promise<Readiness> {
  return async () => {
    const pgbouncer = await probePgBouncer(opts);
    if (!pgbouncer.ok || !opts.query) return { ok: pgbouncer.ok, pgbouncer };
    const started = performance.now();
    const limit = opts.queryTimeoutMs ?? 3000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        opts.query(),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`query took longer than ${limit} ms`)), limit))),
      ]);
      return { ok: true, pgbouncer, query: { ok: true, latencyMs: Math.round(performance.now() - started) } };
    } catch (e) {
      // the driver's message only: it may name a database but never a password
      const error = e instanceof Error ? e.message.split("\n")[0]!.slice(0, 200) : "query failed";
      return { ok: false, pgbouncer, query: { ok: false, latencyMs: Math.round(performance.now() - started), error } };
    } finally {
      clearTimeout(timer);
    }
  };
}
