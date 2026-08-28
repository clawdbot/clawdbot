// Post-core plugin finalization, fresh-process handoff, and control-plane sentinel updates.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  createPluginInstallRecordMap,
  serializePluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { hasErrnoCode } from "../../infra/errors.js";
import { readJsonIfExists, writeJson } from "../../infra/json-files.js";
import {
  EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
  type UpdateChannel,
} from "../../infra/update-channels.js";
import {
  compareSemverStrings,
  type ExtendedStableFailureReason,
} from "../../infra/update-check.js";
import {
  markControlPlaneUpdateRestartSentinelFailure,
  writeControlPlaneUpdateRestartSentinel,
  type ControlPlaneUpdateSentinelMetaFile,
} from "../../infra/update-control-plane-sentinel.js";
import {
  buildPostCoreHandoffEnv,
  POST_CORE_UPDATE_ENV,
  type PreUpdateConfigRestoreInput,
} from "../../infra/update-post-core-context.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { getWindowsSystem32ExePath } from "../../infra/windows-install-roots.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "../../plugins/installed-plugin-index-records.js";
import { restorePersistedInstalledPluginIndexIfCurrent } from "../../plugins/installed-plugin-index-store-write.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { printResult } from "./progress.js";
import { readPackageVersion, resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import {
  normalizePluginInstallRecordMap,
  writePostCoreSourceConfigFile,
} from "./update-command-config.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  isPackageManagerUpdateMode,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service.js";

export { POST_CORE_UPDATE_ENV };
export const POST_CORE_UPDATE_CHANNEL_ENV = "OPENCLAW_UPDATE_POST_CORE_CHANNEL";
export const POST_CORE_UPDATE_RESULT_PATH_ENV = "OPENCLAW_UPDATE_POST_CORE_RESULT_PATH";
export const POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV =
  "OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH";
export const POST_CORE_UPDATE_STARTED_AT_ENV = "OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS";
const POST_CORE_UPDATE_RESULT_POLL_MS = 100;

export async function reportPreMutationUpdateFailure(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  reason:
    | ExtendedStableFailureReason
    | typeof EXTENDED_STABLE_TAG_UNSUPPORTED_REASON
    | "npm lifecycle policy preflight"
    | "unsupported-package-target";
  message?: string;
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
}): Promise<void> {
  const result: UpdateRunResult = {
    status: "error",
    mode: params.installKind === "git" ? "git" : "unknown",
    root: params.root,
    reason: params.reason,
    steps: [],
    durationMs: 0,
  };
  if (params.opts.dryRun !== true) {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(params.opts.json),
    });
  }
  if (params.message) {
    defaultRuntime.error(params.message);
  }
  printResult(result, params.opts);
  defaultRuntime.exit(1);
}

export async function writePostCorePluginUpdateResultFile(
  filePath: string | undefined,
  result: PostCorePluginUpdateResult,
): Promise<void> {
  if (!filePath) {
    return;
  }
  await writeJson(filePath, result, { trailingNewline: true });
}

/** @internal exported for focused handoff contract tests. */
export async function writePostCorePluginInstallRecordsFile(
  filePath: string,
  records: Record<string, PluginInstallRecord>,
): Promise<void> {
  await fs.writeFile(filePath, `${serializePluginInstallRecordMap(records)}\n`, "utf-8");
}

export async function readPostCorePluginInstallRecordsFile(
  filePath: string | undefined,
): Promise<Record<string, PluginInstallRecord> | undefined> {
  if (!filePath) {
    return undefined;
  }
  // Missing handoff is optional (parent may omit the path). Corrupt / unreadable
  // handoff must fail closed: silent undefined previously dropped parent install
  // recovery context when the post-doctor index was still empty.
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return undefined;
    }
    throw new Error(
      `Unable to read plugin install records file: ${filePath}. Run openclaw doctor to inspect and repair plugin installation state.`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed JSON in plugin install records file: ${filePath}. Run openclaw doctor to inspect and repair plugin installation state.`,
      { cause: err },
    );
  }
  try {
    return normalizePluginInstallRecordMap(parsed);
  } catch (err) {
    throw new Error(
      `Invalid plugin install records in handoff file: ${filePath}. Run openclaw doctor to inspect and repair plugin installation state.`,
      { cause: err },
    );
  }
}

async function execFileStdout(file: string, args: string[]): Promise<string | undefined> {
  return await runExec(file, args, { logOutput: false, timeoutMs: 1000 }).then(
    ({ stdout }) => stdout,
    () => undefined,
  );
}

async function readProcessStartTimeMs(pid: number): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const raw =
    process.platform === "win32"
      ? await execFileStdout("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::Out.Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o"))`,
        ])
      : await execFileStdout("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw.trim().replace(/\s+/g, " "));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function resolvePostCoreUpdateStartedAtMs(
  env: NodeJS.ProcessEnv,
): Promise<number | undefined> {
  const fromEnv = parseStrictPositiveInteger(env[POST_CORE_UPDATE_STARTED_AT_ENV] ?? "");
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  return await readProcessStartTimeMs(process.ppid);
}

async function readPostCorePluginUpdateResultFile(
  filePath: string,
): Promise<PostCorePluginUpdateResult | undefined> {
  try {
    const parsed = await readJsonIfExists<PostCorePluginUpdateResult>(filePath);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.status === "ok" ||
        parsed.status === "warning" ||
        parsed.status === "skipped" ||
        parsed.status === "error")
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stopPostCoreUpdateChild(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn(
        getWindowsSystem32ExePath("taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.once("error", () => {
        child.kill();
      });
      return;
    } catch {
      child.kill();
      return;
    }
  }
  child.kill();
}

/**
 * Returns the stdio mode for the post-core-update child process.
 *
 * Windows shells (PowerShell/CMD) wait for all processes that hold inherited console handles to
 * exit before returning the prompt, even after the immediate child has exited.  Using "pipe" on
 * Windows prevents the child (and any grandchildren it spawns) from ever receiving a reference to
 * the parent's console handles, eliminating the terminal hang seen in #78445.
 *
 * @internal exported for testing
 */
export function resolvePostCoreUpdateChildStdio(
  platform: NodeJS.Platform = process.platform,
  jsonMode = false,
): "inherit" | "pipe" {
  return platform === "win32" || jsonMode ? "pipe" : "inherit";
}

/** @internal exported for focused handoff contract tests. */
export function preparePostCorePluginInstallRecordsForFreshProcess(params: {
  records: Record<string, PluginInstallRecord>;
  targetVersion: string | null;
}): Record<string, PluginInstallRecord> {
  if (!params.targetVersion) {
    return params.records;
  }
  const runtimeComparison = compareSemverStrings(VERSION, params.targetVersion);
  if (runtimeComparison === null || runtimeComparison <= 0) {
    return params.records;
  }
  let changed = false;
  const next = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const [pluginId, record] of Object.entries(params.records)) {
    const installedVersion = record.resolvedVersion ?? record.version;
    const comparison = installedVersion
      ? compareSemverStrings(installedVersion, params.targetVersion)
      : null;
    if (record.source !== "npm" || comparison === null || comparison <= 0) {
      setPluginInstallRecordMapEntry(next, pluginId, record);
      continue;
    }
    const { resolvedSpec: _resolvedSpec, resolvedVersion: _resolvedVersion, ...rest } = record;
    setPluginInstallRecordMapEntry(next, pluginId, rest);
    changed = true;
  }
  return changed ? next : params.records;
}

export async function continuePostCoreUpdateInFreshProcess(params: {
  root: string;
  channel: UpdateChannel;
  requestedChannel: UpdateChannel | null;
  opts: UpdateCommandOptions;
  pluginInstallRecords: Record<string, PluginInstallRecord>;
  preUpdateConfig?: PreUpdateConfigRestoreInput;
  updateStartedAtMs: number;
  nodeRunner?: string;
}): Promise<{
  resumed: boolean;
  pluginUpdate?: PostCorePluginUpdateResult;
  exitCode?: number;
}> {
  const entryPath = await resolveGatewayInstallEntrypoint(params.root);
  if (!entryPath) {
    return { resumed: false };
  }

  const argv = [entryPath, "update"];
  if (params.opts.json) {
    argv.push("--json");
  }
  if (params.opts.restart === false) {
    argv.push("--no-restart");
  }
  if (params.opts.yes) {
    argv.push("--yes");
  }
  if (params.opts.timeout) {
    argv.push("--timeout", params.opts.timeout);
  }
  const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-post-core-"));
  const resultPath = path.join(resultDir, "plugins.json");
  const installRecordsPath = path.join(resultDir, "plugin-install-records.json");
  const sourceConfigPath = path.join(resultDir, "source-config.json");
  const postCoreHostVersion = await readPackageVersion(params.root);

  const pluginInstallRecords = preparePostCorePluginInstallRecordsForFreshProcess({
    records: params.pluginInstallRecords,
    targetVersion: postCoreHostVersion,
  });
  let tentativePluginIndex:
    | Awaited<ReturnType<typeof writePersistedInstalledPluginIndexInstallRecordsWithLease>>
    | undefined;
  const restoreTentativePluginIndex = async () => {
    const tentative = tentativePluginIndex;
    if (!tentative) {
      return;
    }
    await withPluginLifecycleLease({}, async (lease) => {
      await restorePersistedInstalledPluginIndexIfCurrent(tentative.previous, tentative.revision, {
        lease,
      });
    });
    tentativePluginIndex = undefined;
  };

  try {
    if (pluginInstallRecords && pluginInstallRecords !== params.pluginInstallRecords) {
      await withPluginLifecycleLease({}, async (lease) => {
        tentativePluginIndex = await writePersistedInstalledPluginIndexInstallRecordsWithLease(
          pluginInstallRecords,
          {
            ...(params.preUpdateConfig ? { config: params.preUpdateConfig.sourceConfig } : {}),
            lease,
          },
        );
      });
    }
    await writePostCorePluginInstallRecordsFile(installRecordsPath, pluginInstallRecords);
    await writePostCoreSourceConfigFile(sourceConfigPath, params.preUpdateConfig);
    const jsonMode = params.opts.json === true;
    const childStdio = resolvePostCoreUpdateChildStdio(process.platform, jsonMode);
    const handoffEnv = buildPostCoreHandoffEnv({
      baseEnv: stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
      compatHostVersion: postCoreHostVersion,
      requestedChannel: params.requestedChannel,
      sourceConfigPath: params.preUpdateConfig ? sourceConfigPath : undefined,
    });
    const child = spawn(params.nodeRunner ?? resolveNodeRunner(), argv, {
      stdio: childStdio,
      env: {
        ...handoffEnv,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        [POST_CORE_UPDATE_ENV]: "1",
        [POST_CORE_UPDATE_CHANNEL_ENV]: params.channel,
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: resultPath,
        [POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV]: installRecordsPath,
        [POST_CORE_UPDATE_STARTED_AT_ENV]: String(params.updateStartedAtMs),
      },
    });
    // JSON callers own stdout, so child diagnostics must remain off that protocol stream.
    if (childStdio === "pipe") {
      child.stdout?.pipe(jsonMode ? process.stderr : process.stdout);
      child.stderr?.pipe(process.stderr);
    }

    const childResult = await new Promise<
      | { kind: "exit"; exitCode: number }
      | { kind: "plugin-update"; pluginUpdate: PostCorePluginUpdateResult }
    >((resolve, reject) => {
      let settled = false;
      const finish = (
        result:
          | { kind: "exit"; exitCode: number }
          | { kind: "plugin-update"; pluginUpdate: PostCorePluginUpdateResult },
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(resultPoll);
        resolve(result);
        if (result.kind === "plugin-update") {
          // Only the winning result stops the child. Claim completion first so its
          // signal cannot reject committed work and roll the plugin index back.
          stopPostCoreUpdateChild(child);
        }
      };
      const resultPoll = setInterval(() => {
        void readPostCorePluginUpdateResultFile(resultPath)
          .then((pluginUpdate) => {
            if (pluginUpdate) {
              finish({ kind: "plugin-update", pluginUpdate });
            }
          })
          .catch(() => undefined);
      }, POST_CORE_UPDATE_RESULT_POLL_MS);
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(resultPoll);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        if (signal) {
          settled = true;
          clearInterval(resultPoll);
          reject(new Error(`post-update process terminated by signal ${signal}`));
          return;
        }
        finish({ kind: "exit", exitCode: code ?? 1 });
      });
    });

    const pluginUpdate =
      childResult.kind === "plugin-update"
        ? childResult.pluginUpdate
        : await readPostCorePluginUpdateResultFile(resultPath);
    const exitCode = childResult.kind === "exit" ? childResult.exitCode : 0;
    if (exitCode !== 0) {
      if (pluginUpdate) {
        return { resumed: true, pluginUpdate };
      }
      await restoreTentativePluginIndex();
      return { resumed: false, exitCode };
    }
    return { resumed: true, ...(pluginUpdate ? { pluginUpdate } : {}) };
  } catch (error) {
    try {
      await restoreTentativePluginIndex();
    } catch (rollbackError) {
      throw new Error("Post-core update failed and could not restore the previous plugin index", {
        cause: rollbackError,
      });
    }
    throw error;
  } finally {
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function didCoreUpdateChangeInstall(result: UpdateRunResult): boolean {
  if (isPackageManagerUpdateMode(result.mode)) {
    return true;
  }
  if (result.mode !== "git") {
    return false;
  }
  const beforeSha = normalizeOptionalString(result.before?.sha);
  const afterSha = normalizeOptionalString(result.after?.sha);
  if (beforeSha && afterSha && beforeSha !== afterSha) {
    return true;
  }
  const beforeVersion = normalizeOptionalString(result.before?.version);
  const afterVersion = normalizeOptionalString(result.after?.version);
  return Boolean(beforeVersion && afterVersion && beforeVersion !== afterVersion);
}

export function shouldResumePostCoreUpdateInFreshProcess(params: {
  result: UpdateRunResult;
  downgradeRisk: boolean;
  installKindChanged?: boolean;
}): boolean {
  // A package-to-git switch can land on the same version already cloned at its
  // target SHA. The package root still changed, so old hashed chunks are unsafe.
  return (
    params.result.status === "ok" &&
    !params.downgradeRisk &&
    (params.installKindChanged === true || didCoreUpdateChangeInstall(params.result))
  );
}

export async function writeControlPlaneUpdateRestartSentinelBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  result: UpdateRunResult;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await writeControlPlaneUpdateRestartSentinel({
      meta: params.meta,
      result: params.result,
    });
  } catch (err) {
    const message = `Failed to write update.run restart sentinel: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

export async function markControlPlaneUpdateRestartSentinelFailureBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  reason: string;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await markControlPlaneUpdateRestartSentinelFailure(params.reason);
  } catch (err) {
    const message = `Failed to mark update.run restart sentinel failed: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}
