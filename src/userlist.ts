import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { PgBouncerError } from "./errors";

/** PostgreSQL's default `scram_iterations`. */
export const SCRAM_ITERATIONS = 4096;

const USER = /^[A-Za-z0-9_.$-]{1,63}$/;
const SCRAM = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*):([A-Za-z0-9+/]+=*)$/;
const MD5 = /^md5[0-9a-f]{32}$/;

function checkUser(user: string): void {
  if (typeof user !== "string" || !USER.test(user)) {
    throw new PgBouncerError("PGBOUNCER_BAD_USER", "A user name must be 1-63 letters, digits, _ . $ or -");
  }
}

// ---- SASLprep (RFC 4013), as PostgreSQL applies it before hashing ------------------------------

const NON_ASCII_SPACE = /[   -​  　]/g;
const MAPPED_TO_NOTHING = /[­͏᠆᠋-᠍‌‍⁠︀-️﻿]/g;
// eslint-disable-next-line no-control-regex
const PROHIBITED = /[\u0000-\u001f\u007f-\u009f̀́‎‏‪-‮⁪-⁯-￹-�]|[\ud800-\udfff]/;

/**
 * PostgreSQL normalises a SCRAM password with SASLprep and, when the password is not valid
 * SASLprep input, hashes the raw UTF-8 bytes instead. This does the same.
 */
export function saslprep(password: string): string {
  if (/^[\x20-\x7e]*$/.test(password)) return password;
  const mapped = password.replace(NON_ASCII_SPACE, " ").replace(MAPPED_TO_NOTHING, "").normalize("NFKC");
  if (!mapped || PROHIBITED.test(mapped)) return password;
  return mapped;
}

export interface ScramOptions {
  /** 16 random bytes by default. Pass the server's salt to reproduce its verifier. */
  salt?: Uint8Array;
  /** Default 4096 (PostgreSQL's default). */
  iterations?: number;
}

/**
 * A SCRAM-SHA-256 verifier in PostgreSQL's format (`SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`).
 * It is what `pg_authid.rolpassword` holds, and what PgBouncer's userlist takes.
 */
export function scramVerifier(password: string, opts: ScramOptions = {}): string {
  if (typeof password !== "string" || !password) throw new PgBouncerError("PGBOUNCER_BAD_USER", "The password is empty");
  const iterations = opts.iterations ?? SCRAM_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) throw new PgBouncerError("PGBOUNCER_BAD_USER", "iterations must be a positive whole number");
  const salt = Buffer.from(opts.salt ?? randomBytes(16));
  const salted = pbkdf2Sync(Buffer.from(saslprep(password), "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** Splits a verifier into its parts; `null` when it is not one. */
export function parseScramVerifier(v: string): { iterations: number; salt: Buffer; storedKey: Buffer; serverKey: Buffer } | null {
  const m = SCRAM.exec(v);
  if (!m) return null;
  return { iterations: Number(m[1]), salt: Buffer.from(m[2]!, "base64"), storedKey: Buffer.from(m[3]!, "base64"), serverKey: Buffer.from(m[4]!, "base64") };
}

/** Does `password` match this SCRAM verifier? (Useful to check a userlist against a known password.) */
export function verifyScram(password: string, verifier: string): boolean {
  const p = parseScramVerifier(verifier);
  if (!p) return false;
  return scramVerifier(password, { salt: p.salt, iterations: p.iterations }) === verifier;
}

/** PostgreSQL's legacy MD5 secret: `"md5" + md5(password + user)`. Prefer SCRAM. */
export function md5Secret(user: string, password: string): string {
  checkUser(user);
  if (typeof password !== "string" || !password) throw new PgBouncerError("PGBOUNCER_BAD_USER", "The password is empty");
  return `md5${createHash("md5").update(password + user).digest("hex")}`;
}

export const isScramVerifier = (s: string): boolean => SCRAM.test(s);
export const isMd5Secret = (s: string): boolean => MD5.test(s);

/** How a plain password is written to the userlist. */
export type SecretFormat = "scram" | "md5" | "plain";

export interface UserEntry {
  user: string;
  /**
   * A SCRAM verifier or MD5 secret (written as it is), or a plain password, which is converted with
   * `format` (`scram` by default).
   */
  secret: string;
  /**
   * Overrides the list's format for this entry. The `auth_user` of `auth_query` needs `plain`:
   * PgBouncer logs in as that user itself, so a SCRAM verifier cannot be passed through for it.
   */
  format?: SecretFormat;
}

/** Turns one entry's secret into what the userlist stores. */
export function userSecret(entry: UserEntry, format: SecretFormat = "scram", opts: ScramOptions = {}): string {
  checkUser(entry.user);
  format = entry.format ?? format;
  const s = entry.secret;
  if (typeof s !== "string" || !s) throw new PgBouncerError("PGBOUNCER_BAD_USER", `User ${entry.user} has no password`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new PgBouncerError("PGBOUNCER_BAD_USER", `The password of ${entry.user} contains a control character`);
  if (isScramVerifier(s) || isMd5Secret(s)) return s;
  if (s.startsWith("SCRAM-SHA-256$")) throw new PgBouncerError("PGBOUNCER_BAD_USER", `The SCRAM verifier of ${entry.user} is malformed`);
  if (format === "scram") return scramVerifier(s, opts);
  if (format === "md5") return md5Secret(entry.user, s);
  return s;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Renders userlist.txt (`"user" "secret"` per line). Plain passwords are converted to `format`
 * (SCRAM by default), so the file holds no password unless you ask for `plain`.
 */
export function renderUserlist(entries: UserEntry[], format: SecretFormat = "scram", opts: ScramOptions = {}): string {
  const seen = new Set<string>();
  const lines = entries.map((e) => {
    checkUser(e.user);
    if (seen.has(e.user)) throw new PgBouncerError("PGBOUNCER_BAD_USER", `User ${e.user} is listed twice`);
    seen.add(e.user);
    return `${quote(e.user)} ${quote(userSecret(e, format, opts))}`;
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Reads a userlist back into entries (comments with `;` or `#`, blank lines ignored). */
export function parseUserlist(text: string): UserEntry[] {
  const out: UserEntry[] = [];
  const field = /"((?:[^"]|"")*)"/y;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    field.lastIndex = 0;
    const u = field.exec(line);
    const rest = line.slice(field.lastIndex).trimStart();
    field.lastIndex = 0;
    const p = field.exec(rest);
    if (!u || !p) throw new PgBouncerError("PGBOUNCER_BAD_USER", "Malformed userlist line");
    out.push({ user: u[1]!.replace(/""/g, '"'), secret: p[1]!.replace(/""/g, '"') });
  }
  return out;
}

/**
 * The query that reads the verifiers PostgreSQL already holds (run as a superuser). Feed the rows
 * to `userlistFromRows`: the userlist then matches the server exactly, which SCRAM pass-through needs.
 */
export const PG_SHADOW_QUERY = "SELECT usename, passwd FROM pg_catalog.pg_shadow WHERE passwd IS NOT NULL AND NOT usesuper";

export function userlistFromRows(rows: { usename: string; passwd: string | null }[]): string {
  return renderUserlist(rows.filter((r) => r.passwd).map((r) => ({ user: r.usename, secret: r.passwd! })), "plain");
}

/**
 * SQL that sets a role's password to this exact verifier, so PostgreSQL and PgBouncer hold the same
 * SCRAM secret. PostgreSQL stores a pre-hashed verifier as it is; the password itself never reaches the server.
 */
export function alterRoleSql(user: string, verifier: string): string {
  checkUser(user);
  if (!isScramVerifier(verifier)) throw new PgBouncerError("PGBOUNCER_BAD_USER", "alterRoleSql takes a SCRAM verifier, not a password");
  return `ALTER ROLE ${quote(user)} PASSWORD '${verifier}';`;
}

/** The function `authQuerySetupSql` creates, and the `auth.query` that calls it. */
export const AUTH_QUERY = "SELECT uname, phash FROM pgbouncer.user_lookup($1)";

/**
 * SQL (run once as a superuser, in the database `auth.dbname` names) for PgBouncer's `auth_query`:
 * a login role for PgBouncer, and a SECURITY DEFINER lookup that never returns superusers.
 * Give that role a password and put it in the userlist with `format: "plain"` (PgBouncer logs in as
 * it, so it needs the password itself; keep the userlist file at mode 600).
 */
export function authQuerySetupSql(authUser = "pgbouncer_auth"): string {
  checkUser(authUser);
  const role = quote(authUser);
  return `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${authUser}') THEN
    CREATE ROLE ${role} LOGIN;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS pgbouncer;
REVOKE ALL ON SCHEMA pgbouncer FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO ${role};
CREATE OR REPLACE FUNCTION pgbouncer.user_lookup(i_username text, OUT uname text, OUT phash text)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  SELECT usename, passwd INTO uname, phash FROM pg_catalog.pg_shadow
  WHERE usename = i_username AND NOT usesuper;
  RETURN;
END
$fn$;
REVOKE ALL ON FUNCTION pgbouncer.user_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.user_lookup(text) TO ${role};
`;
}
