// Post-core plugin finalization, fresh-process handoff, and control-plane sentinel updates.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS_ENV } from "../../commands/doctor-invocation.js";
import { doctorCommand } from "../../commands/doctor.js";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { readJsonIfExists, writeJson } from "../../infra/json-files.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import {
  DEFAULT_PACKAGE_CHANNEL,
  EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
  normalizeUpdateChannel,
  type UpdateChannel,
  UPDATE_EFFECTIVE_CHANNEL_ENV,
} from "../../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  type ExtendedStableFailureReason,
} from "../../infra/update-check.js";
import {
  markControlPlaneUpdateRestartSentinelFailure,
  writeControlPlaneUpdateRestartSentinel,
  type ControlPlaneUpdateSentinelMetaFile,
} from "../../infra/update-control-plane-sentinel.js";
import {
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
  type PreUpdateConfigRestoreInput,
} from "../../infra/update-post-core-context.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { getWindowsSystem32ExePath } from "../../infra/windows-install-roots.js";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { printResult } from "./progress.js";
import {
  parseTimeoutMsOrExit,
  readPackageVersion,
  resolveNodeRunner,
  resolveUpdateRoot,
  tryWriteCompletionCache,
  type UpdateCommandOptions,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import {
  createUpdateConfigSnapshot,
  normalizePluginInstallRecordMap,
  persistRequestedUpdateChannel,
  readPostCorePreUpdateSourceConfig,
  restoreDroppedPreUpdateChannels,
  writePostCoreSourceConfigFile,
} from "./update-command-config.js";
import {
  updatePluginsAfterCoreUpdate,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  isPackageManagerUpdateMode,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service.js";

const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;
export const POST_CORE_UPDATE_ENV = "OPENCLAW_UPDATE_POST_CORE";
export const POST_CORE_UPDATE_CHANNEL_ENV = "OPENCLAW_UPDATE_POST_CORE_CHANNEL";
export const POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV = "OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL";
export const POST_CORE_UPDATE_RESULT_PATH_ENV = "OPENCLAW_UPDATE_POST_CORE_RESULT_PATH";
export const POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV =
  "OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH";
const POST_CORE_UPDATE_STARTED_AT_ENV = "OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS";
const POST_CORE_UPDATE_RESULT_POLL_MS = 100;

export async function reportPreMutationUpdateFailure(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  reason: ExtendedStableFailureReason | typeof EXTENDED_STABLE_TAG_UNSUPPORTED_REASON;
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
  await writeControlPlaneUpdateRestartSentinelBestEffort({
    meta: params.controlPlaneUpdateSentinelMeta,
    result,
    jsonMode: Boolean(params.opts.json),
  });
  printResult(result, params.opts);
  defaultRuntime.exit(1);
}

type UpdateFinalizeResult = {
  status: "ok" | "warning" | "error";
  mode: "finalize";
  root: string;
  channel: UpdateChannel;
  restart: false;
  postUpdate: {
    doctor: {
      status: "ok";
    };
    plugins: PostCorePluginUpdateResult;
  };
};

function withUpdateFinalizationEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  const previousDeferConfiguredPluginInstallRepair =
    process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV];
  const previousParentSupportsDoctorConfigWrite =
    process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV];
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV] = "1";
  process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] = "1";
  return run().finally(() => {
    if (previousUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = previousUpdateInProgress;
    }
    if (previousDeferConfiguredPluginInstallRepair === undefined) {
      delete process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV];
    } else {
      process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV] =
        previousDeferConfiguredPluginInstallRepair;
    }
    if (previousParentSupportsDoctorConfigWrite === undefined) {
      delete process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV];
    } else {
      process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] =
        previousParentSupportsDoctorConfigWrite;
    }
  });
}

export async function updateFinalizeCommand(opts: UpdateFinalizeOptions): Promise<void> {
  suppressDeprecations();
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  if (timeoutMs === null) {
    return;
  }
  assertConfigWriteAllowedInCurrentMode();

  const root = await resolveUpdateRoot();
  let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  const preFinalizeConfig =
    (await readPostCorePreUpdateSourceConfig({
      sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
      currentSnapshot: configSnapshot,
    })) ??
    (configSnapshot.valid
      ? {
          sourceConfig: configSnapshot.sourceConfig,
          authoredConfig: isRecord(configSnapshot.parsed)
            ? (configSnapshot.parsed as OpenClawConfig)
            : configSnapshot.sourceConfig,
        }
      : undefined);
  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(
      `--channel must be "stable", "extended-stable", "beta", or "dev" (got "${opts.channel}")`,
    );
    defaultRuntime.exit(1);
    return;
  }
  if (requestedChannel === "extended-stable") {
    const updateStatus = await checkUpdateStatus({
      root,
      timeoutMs: timeoutMs ?? 3500,
      fetchGit: false,
      includeRegistry: false,
    });
    if (updateStatus.installKind === "git") {
      await reportPreMutationUpdateFailure({
        root,
        installKind: updateStatus.installKind,
        reason: "unsupported_git_channel",
        opts,
        controlPlaneUpdateSentinelMeta: null,
      });
      return;
    }
  }
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  // Effective channel the core update actually ran on (e.g. git/dev for an
  // unconfigured source update), passed by the caller via env. Used only as a
  // convergence fallback; it is never persisted (that stays gated on
  // `requestedChannel`), so a default source update does not write update.channel.
  const effectiveChannel = normalizeUpdateChannel(
    process.env[UPDATE_EFFECTIVE_CHANNEL_ENV]?.trim(),
  );
  const channel = requestedChannel ?? storedChannel ?? effectiveChannel ?? DEFAULT_PACKAGE_CHANNEL;
  if (requestedChannel) {
    configSnapshot = await persistRequestedUpdateChannel({
      configSnapshot,
      requestedChannel,
    });
  }

  const pluginUpdate = await withUpdateFinalizationEnv(async () => {
    await createUpdateConfigSnapshot();
    await doctorCommand(defaultRuntime, {
      nonInteractive: true,
      repair: true,
      yes: opts.yes === true,
      crossStateDirImports: false,
    });
    configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    if (requestedChannel) {
      configSnapshot = await persistRequestedUpdateChannel({
        configSnapshot,
        requestedChannel,
      });
    }
    const restoredConfig = restoreDroppedPreUpdateChannels(configSnapshot, preFinalizeConfig);
    configSnapshot = restoredConfig.snapshot;
    const postDoctorStoredChannel = configSnapshot.valid
      ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
      : null;
    const postDoctorChannel =
      requestedChannel ??
      postDoctorStoredChannel ??
      storedChannel ??
      effectiveChannel ??
      DEFAULT_PACKAGE_CHANNEL;
    const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
    return await updatePluginsAfterCoreUpdate({
      root,
      channel: postDoctorChannel,
      configSnapshot,
      configChanged: restoredConfig.changed,
      restoredAuthoredChannels: restoredConfig.authoredChannels,
      opts: {
        json: opts.json,
        timeout: opts.timeout,
        yes: opts.yes,
        restart: false,
        acknowledgeClawHubRisk: opts.acknowledgeClawHubRisk,
      },
      timeoutMs: timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
      pluginInstallRecords,
    });
  });

  const result: UpdateFinalizeResult = {
    status:
      pluginUpdate.status === "error"
        ? "error"
        : pluginUpdate.status === "warning"
          ? "warning"
          : "ok",
    mode: "finalize",
    root,
    channel:
      requestedChannel ??
      (configSnapshot.valid
        ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
        : null) ??
      channel,
    restart: false,
    postUpdate: {
      doctor: {
        status: "ok",
      },
      plugins: pluginUpdate,
    },
  };

  await tryWriteCompletionCache(root, Boolean(opts.json));
  if (opts.json) {
    defaultRuntime.writeJson(result);
  } else if (result.status === "ok") {
    defaultRuntime.log(theme.muted("Update finalization completed."));
  }
  if (result.status === "error") {
    defaultRuntime.exit(1);
  }
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

async function writePostCorePluginInstallRecordsFile(
  filePath: string,
  records: Record<string, PluginInstallRecord>,
): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(records)}\n`, "utf-8");
}

export async function readPostCorePluginInstallRecordsFile(
  filePath: string | undefined,
): Promise<Record<string, PluginInstallRecord> | undefined> {
  if (!filePath) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
    return normalizePluginInstallRecordMap(parsed);
  } catch {
    return undefined;
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
): "inherit" | "pipe" {
  return platform === "win32" ? "pipe" : "inherit";
}

function preparePostCorePluginInstallRecordsForFreshProcess(params: {
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
  const next: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(params.records)) {
    const installedVersion = record.resolvedVersion ?? record.version;
    const comparison = installedVersion
      ? compareSemverStrings(installedVersion, params.targetVersion)
      : null;
    if (record.source !== "npm" || comparison === null || comparison <= 0) {
      next[pluginId] = record;
      continue;
    }
    const { resolvedSpec: _resolvedSpec, resolvedVersion: _resolvedVersion, ...rest } = record;
    next[pluginId] = rest;
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
  if (params.opts.acknowledgeClawHubRisk) {
    argv.push("--acknowledge-clawhub-risk");
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

  try {
    if (pluginInstallRecords && pluginInstallRecords !== params.pluginInstallRecords) {
      await writePersistedInstalledPluginIndexInstallRecords(pluginInstallRecords);
    }
    await writePostCorePluginInstallRecordsFile(installRecordsPath, pluginInstallRecords);
    await writePostCoreSourceConfigFile(sourceConfigPath, params.preUpdateConfig);
    const childStdio = resolvePostCoreUpdateChildStdio();
    const child = spawn(params.nodeRunner ?? resolveNodeRunner(), argv, {
      stdio: childStdio,
      env: {
        ...stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        [DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS_ENV]: "1",
        [POST_CORE_UPDATE_ENV]: "1",
        [POST_CORE_UPDATE_CHANNEL_ENV]: params.channel,
        ...(params.requestedChannel
          ? { [POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]: params.requestedChannel }
          : {}),
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: resultPath,
        [POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV]: installRecordsPath,
        [POST_CORE_UPDATE_STARTED_AT_ENV]: String(params.updateStartedAtMs),
        ...(postCoreHostVersion === null
          ? {}
          : { OPENCLAW_COMPATIBILITY_HOST_VERSION: postCoreHostVersion }),
        ...(params.preUpdateConfig
          ? { [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: sourceConfigPath }
          : {}),
      },
    });
    // When piped, relay child output to the parent process so terminal output is preserved.
    if (childStdio === "pipe") {
      child.stdout?.pipe(process.stdout);
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
      };
      const resultPoll = setInterval(() => {
        void readPostCorePluginUpdateResultFile(resultPath)
          .then((pluginUpdate) => {
            if (!pluginUpdate) {
              return;
            }
            stopPostCoreUpdateChild(child);
            finish({ kind: "plugin-update", pluginUpdate });
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
      return { resumed: false, exitCode };
    }
    return { resumed: true, ...(pluginUpdate ? { pluginUpdate } : {}) };
  } finally {
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function shouldResumePostCoreUpdateInFreshProcess(params: {
  result: UpdateRunResult;
  downgradeRisk: boolean;
}): boolean {
  if (params.downgradeRisk) {
    return false;
  }
  if (isPackageManagerUpdateMode(params.result.mode)) {
    return true;
  }
  if (params.result.mode !== "git") {
    return false;
  }
  const beforeSha = normalizeOptionalString(params.result.before?.sha);
  const afterSha = normalizeOptionalString(params.result.after?.sha);
  if (beforeSha && afterSha && beforeSha !== afterSha) {
    return true;
  }
  const beforeVersion = normalizeOptionalString(params.result.before?.version);
  const afterVersion = normalizeOptionalString(params.result.after?.version);
  return Boolean(beforeVersion && afterVersion && beforeVersion !== afterVersion);
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
