// mgpl-pgbouncer: the kit from a shell (container entrypoints, CI, one-off setup).
// It prints file paths and verifiers, never a password.
import { chmodSync, chownSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderCompose } from "./compose";
import { configFromEnv, secretFormatFromEnv, usersFromEnv } from "./env";
import { isPgBouncerError } from "./errors";
import { waitForPgBouncer } from "./health";
import { renderIni } from "./ini";
import { alterRoleSql, authQuerySetupSql, renderUserlist, scramVerifier } from "./userlist";

const HELP = `mgpl-pgbouncer <command>

  render [--out DIR] [--chown UID[:GID]]
                                write pgbouncer.ini and userlist.txt (mode 600) from PGBOUNCER_* variables
                                (default DIR: ./pgbouncer; --chown 70 for the compose image's postgres user)
  verifier USER                 read a password from stdin; print its SCRAM verifier and the ALTER ROLE
                                statement that sets the same verifier on PostgreSQL
  auth-setup [AUTH_USER]        print the SQL for auth_query (default role: pgbouncer_auth)
  compose [--name N] [--port P] [--config-dir D] [--tls-dir D] [--publish [IP:]PORT] [--image I]
          [--depends-on a,b]    print a docker-compose service (use --depends-on "" for none)
  check [--host H] [--port P] [--wait MS]
                                exit 0 once PgBouncer answers, 1 otherwise
`;

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const next = args[i + 1];
    out[a.slice(2)] = next !== undefined && !next.startsWith("--") ? (i++, next) : "";
  }
  return out;
}

const int = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  switch (cmd) {
    case "render": {
      const out = f.out || "./pgbouncer";
      const config = configFromEnv(process.env);
      const ini = renderIni(config);
      const users = renderUserlist(usersFromEnv(process.env), secretFormatFromEnv(process.env));
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "pgbouncer.ini"), ini, { mode: 0o644 });
      const userlist = join(out, "userlist.txt");
      writeFileSync(userlist, users, { mode: 0o600 });
      chmodSync(userlist, 0o600);
      if (f.chown) {
        // the compose image runs as postgres (uid 70) and must be able to read the userlist
        const m = /^(\d+)(?::(\d+))?$/.exec(f.chown);
        if (!m) throw new Error("--chown takes UID or UID:GID");
        chownSync(userlist, Number(m[1]), Number(m[2] ?? m[1]));
      }
      console.log(`wrote ${join(out, "pgbouncer.ini")} and ${userlist} (${users ? users.trim().split("\n").length : 0} users)`);
      return 0;
    }
    case "verifier": {
      const user = rest[0];
      if (!user || user.startsWith("--")) break;
      const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
      const v = scramVerifier(password);
      console.log(v);
      console.log(alterRoleSql(user, v));
      return 0;
    }
    case "auth-setup":
      process.stdout.write(authQuerySetupSql(rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined));
      return 0;
    case "compose":
      process.stdout.write(
        renderCompose({
          name: f.name || undefined,
          port: int(f.port),
          configDir: f["config-dir"] || undefined,
          tlsDir: f["tls-dir"] || undefined,
          publish: f.publish || undefined,
          image: f.image || undefined,
          dependsOn: "depends-on" in f ? f["depends-on"]!.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        }),
      );
      return 0;
    case "check": {
      const r = await waitForPgBouncer({ host: f.host || undefined, port: int(f.port), waitMs: int(f.wait) ?? 0 });
      console.log(`ok (${r.latencyMs} ms, tls ${r.tls ? "offered" : "not offered"})`);
      return 0;
    }
  }
  process.stderr.write(HELP);
  return cmd === "help" || cmd === "--help" ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(isPgBouncerError(e) ? `${e.code}: ${e.message}` : (e as Error).message);
    process.exit(1);
  },
);
