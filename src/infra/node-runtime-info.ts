import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { runExec } from "../process/exec.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";

export type NodeRuntimeExec = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

const NODE_RUNTIME_PROBE_TIMEOUT_MS = 5_000;

const execNodeRuntime: NodeRuntimeExec = async (file, args, options) =>
  await runExec(file, [...args], { logOutput: false, timeoutMs: options.timeoutMs });

const NODE_RUNTIME_PROBE = String.raw`
let sqliteVersion = null;
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get()?.version ?? null;
  } finally {
    db.close();
  }
} catch {}
const variables = (process.config && process.config.variables) || {};
const nodeSharedSqlite = variables.node_shared_sqlite === true || variables.node_shared_sqlite === "true";
process.stdout.write(JSON.stringify({ nodeVersion: process.versions.node, sqliteVersion, nodeSharedSqlite }));
`;

type NodeRuntimeInfo = {
  nodeVersion: string | null;
  sqliteVersion: string | null;
  nodeSharedSqlite: boolean;
  supported: boolean;
};

/** Probes one Node executable against the runtime and SQLite safety contract. */
export async function resolveNodeRuntimeInfo(
  nodePath: string,
  execFileImpl: NodeRuntimeExec = execNodeRuntime,
): Promise<NodeRuntimeInfo> {
  try {
    const { stdout } = await execFileImpl(nodePath, ["-e", NODE_RUNTIME_PROBE], {
      encoding: "utf8",
      timeoutMs: NODE_RUNTIME_PROBE_TIMEOUT_MS,
    });
    const parsed = asOptionalRecord(JSON.parse(stdout));
    const nodeVersion = typeof parsed?.nodeVersion === "string" ? parsed.nodeVersion : null;
    const sqliteVersion = typeof parsed?.sqliteVersion === "string" ? parsed.sqliteVersion : null;
    const nodeSharedSqlite =
      parsed?.nodeSharedSqlite === true || parsed?.nodeSharedSqlite === "true";
    return {
      nodeVersion,
      sqliteVersion,
      nodeSharedSqlite,
      supported:
        isSupportedOpenClawNodeVersion(nodeVersion) &&
        sqliteVersion !== null &&
        isSqliteWalResetSafeVersion(sqliteVersion),
    };
  } catch {
    return { nodeVersion: null, sqliteVersion: null, nodeSharedSqlite: false, supported: false };
  }
}
