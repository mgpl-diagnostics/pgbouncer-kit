/** Error codes are a public contract: add, never rename. */
export type PgBouncerErrorCode =
  | "PGBOUNCER_BAD_CONFIG"
  | "PGBOUNCER_BAD_ENV"
  | "PGBOUNCER_BAD_URL"
  | "PGBOUNCER_BAD_USER"
  | "PGBOUNCER_UNREACHABLE";

export class PgBouncerError extends Error {
  readonly code: PgBouncerErrorCode;
  /** Every problem found, when there was more than one (configuration and environment checks). */
  readonly problems: string[];

  constructor(code: PgBouncerErrorCode, message: string, problems: string[] = [message]) {
    super(message);
    this.name = "PgBouncerError";
    this.code = code;
    this.problems = problems;
  }
}

export const isPgBouncerError = (e: unknown): e is PgBouncerError => e instanceof PgBouncerError;
