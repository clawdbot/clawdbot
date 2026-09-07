import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { parsePackageOpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import { assertSqliteFamilyClosed } from "./update-checkpoint-plan.js";
import type { UpdateCheckpointBinding } from "./update-checkpoint.js";

type PreviousRuntime = UpdateCheckpointBinding["fromRuntime"];

/**
 * Execute the retained release's actual state/agent reader, not this process's
 * schema comparator. This is an AFTER-COMMIT, BEFORE-PUBLICATION operation.
 * An idle caller-owned handle proves we are not approving a stale on-disk image
 * while that handle has uncommitted carry-forward writes. It is never reopened
 * writable here. The caller must close it and revalidate original recovery
 * bindings/records and current exclusion after this awaited operation.
 *
 * The runtime/package owner must keep the retained install and Node immutable
 * under assertCurrent; entry/package checks do not replace package custody.
 * Older releases without the requested explicit reader are unavailable. A
 * database compatibility verdict is not a serving-health verdict.
 */
export async function validateUpdateCheckpointPreviousRuntimeDatabase(params: {
  database: DatabaseSync;
  /** Exact owner from the immutable checkpoint, not a replacement-file lookup. */
  agentId?: string;
  runtime: PreviousRuntime;
  assertCurrent: () => undefined;
  timeoutMs?: number;
}): Promise<
  | { status: "verified"; runtime: PreviousRuntime; databasePath: string; sha256: string }
  | {
      status: "unavailable";
      reason:
        | "uncommitted-database"
        | "runtime-reader-unavailable"
        | "runtime-reader-refused"
        | "validation-state-changed";
    }
> {
  const assertCurrent = () => {
    const result: unknown = params.assertCurrent();
    if (result !== undefined) {
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
      }
      throw new Error("Runtime validation requires synchronous current exclusion");
    }
  };
  let privateRoot: string | undefined;
  let phase: "runtime-reader-unavailable" | "runtime-reader-refused" | "validation-state-changed" =
    "runtime-reader-unavailable";
  try {
    assertCurrent();
    if (params.database.isTransaction) {
      return { status: "unavailable", reason: "uncommitted-database" };
    }
    const databasePath = params.database.location("main");
    if (!databasePath || !path.isAbsolute(databasePath)) {
      return { status: "unavailable", reason: "runtime-reader-unavailable" };
    }
    const { root, nodePath, version } = params.runtime;
    if (
      !path.isAbsolute(root) ||
      !path.isAbsolute(nodePath) ||
      (await fs.realpath(root)) !== root ||
      (await fs.realpath(databasePath)) !== databasePath
    ) {
      throw new Error("Runtime validation requires canonical paths");
    }
    const entry = await resolveGatewayInstallEntrypoint(root);
    if (!entry || !(await fs.realpath(entry)).startsWith(root + path.sep)) {
      throw new Error("Previous runtime has no retained CLI");
    }
    const packagePath = path.join(root, "package.json");
    const metadata: unknown = JSON.parse(await fs.readFile(packagePath, "utf8"));
    const schemas = parsePackageOpenClawSchemaVersions(metadata);
    if (
      !schemas ||
      typeof metadata !== "object" ||
      metadata === null ||
      !("name" in metadata) ||
      metadata.name !== "openclaw" ||
      !("version" in metadata) ||
      metadata.version !== version
    ) {
      throw new Error("Previous runtime metadata mismatch");
    }
    const schemaVersion = params.agentId === undefined ? schemas.state : schemas.agent;
    const files = [databasePath, packagePath, entry, nodePath];
    assertSqliteFamilyClosed(databasePath);
    const before = await Promise.all(files.map(inspectCheckpointFile));
    if (before.some((file) => file?.kind !== "file")) {
      throw new Error("Missing validation input");
    }
    privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-reader-"));
    assertCurrent();
    if (params.database.isTransaction) {
      return { status: "unavailable", reason: "uncommitted-database" };
    }
    assertSqliteFamilyClosed(databasePath);
    phase = "runtime-reader-refused";
    // No inherited NODE_OPTIONS, credentials, profile, config or live state.
    // Run the retained dist entry directly, avoiding package lifecycle repair.
    const result = await runUtf8CommandWithTimeout(
      [
        nodePath,
        entry,
        "database",
        params.agentId === undefined ? "preflight" : "preflight-agent",
        databasePath,
        ...(params.agentId === undefined ? [] : ["--agent-id", params.agentId]),
        "--json",
      ],
      {
        cwd: privateRoot,
        baseEnv: {},
        env: {
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: privateRoot,
          USERPROFILE: privateRoot,
          TMPDIR: privateRoot,
          TMP: privateRoot,
          TEMP: privateRoot,
          OPENCLAW_STATE_DIR: privateRoot,
          OPENCLAW_CONFIG_PATH: path.join(privateRoot, "openclaw.json"),
          NODE_DISABLE_COMPILE_CACHE: "1",
          NO_COLOR: "1",
        },
        timeoutMs: params.timeoutMs ?? 30_000,
        maxOutputBytes: 256 * 1024,
        killProcessTree: true,
      },
    );
    phase = "validation-state-changed";
    assertCurrent();
    if (params.database.isTransaction || params.database.location("main") !== databasePath) {
      throw new Error("Staged transaction changed during validation");
    }
    assertSqliteFamilyClosed(databasePath);
    if (!isDeepStrictEqual(before, await Promise.all(files.map(inspectCheckpointFile)))) {
      throw new Error("Validation input changed");
    }
    phase = "runtime-reader-refused";
    const verdict: unknown = JSON.parse(result.stdout);
    if (
      result.code !== 0 ||
      typeof verdict !== "object" ||
      verdict === null ||
      !("schema" in verdict) ||
      verdict.schema !==
        (params.agentId === undefined
          ? "openclaw.state-schema-preflight.v1"
          : "openclaw.agent-schema-preflight.v1") ||
      (params.agentId !== undefined &&
        (!("agentId" in verdict) || verdict.agentId !== params.agentId)) ||
      !("databasePath" in verdict) ||
      verdict.databasePath !== databasePath ||
      !("status" in verdict) ||
      verdict.status !== "exact" ||
      !("requiresWrite" in verdict) ||
      verdict.requiresWrite !== false ||
      !("foundVersion" in verdict) ||
      verdict.foundVersion !== schemaVersion ||
      !("targetVersion" in verdict) ||
      verdict.targetVersion !== schemaVersion ||
      !("issues" in verdict) ||
      !Array.isArray(verdict.issues) ||
      verdict.issues.length !== 0
    ) {
      return { status: "unavailable", reason: "runtime-reader-refused" };
    }
    assertCurrent();
    return {
      status: "verified",
      runtime: { ...params.runtime },
      databasePath,
      sha256: before[0]!.sha256,
    };
  } catch {
    return { status: "unavailable", reason: phase };
  } finally {
    if (privateRoot) {
      await fs.rm(privateRoot, { recursive: true, force: true });
    }
  }
}
