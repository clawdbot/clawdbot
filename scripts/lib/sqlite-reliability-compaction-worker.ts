import { pathToFileURL } from "node:url";
import { compactDoctorSessionSqliteTarget } from "../../src/commands/doctor-session-sqlite-compact.js";
import { runDoctorStateSqliteCompact } from "../../src/commands/doctor-state-sqlite-compact.js";

type CompactionTarget =
  | { role: "agent"; agentId: string; path: string }
  | { role: "global"; path: string };

function parseTarget(argv: string[]): CompactionTarget {
  const [role, databasePath, agentId, ...extra] = argv;
  if (extra.length > 0 || !databasePath) {
    throw new Error("invalid SQLite compaction worker arguments");
  }
  if (role === "global" && !agentId) {
    return { role, path: databasePath };
  }
  if (role === "agent" && agentId) {
    return { role, agentId, path: databasePath };
  }
  throw new Error("invalid SQLite compaction worker target");
}

async function main(argv: string[]): Promise<void> {
  const target = parseTarget(argv);
  process.send?.({ kind: "ready" });
  if (target.role === "global") {
    const report = await runDoctorStateSqliteCompact({ env: process.env });
    if (report.skipped) {
      throw new Error(`global compaction unexpectedly skipped ${target.path}`);
    }
  } else {
    const report = compactDoctorSessionSqliteTarget(
      {
        agentId: target.agentId,
        storePath: target.path,
      },
      { env: process.env },
    );
    if (report.skipped) {
      throw new Error(`agent compaction unexpectedly skipped ${target.path}`);
    }
  }
  process.send?.({ kind: "completed" });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
