// Runs the post-plugin migration pass without retaining pre-update plugin modules.
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveNodeRunner } from "./shared.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import {
  applyPostPluginConfigValidation,
  POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
} from "./update-command-post-plugin-validation.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service.js";

export function withUpdateFinalizationEnv<T>(run: () => Promise<T>): Promise<T> {
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

async function withNormalConfigValidation<T>(run: () => Promise<T>): Promise<T> {
  const previousUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "0";
  try {
    return await run();
  } finally {
    if (previousUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = previousUpdateInProgress;
    }
  }
}

function createPostPluginDoctorExecutionFailure(
  pluginUpdate: PostCorePluginUpdateResult,
  reason: string,
): PostCorePluginUpdateResult {
  return {
    ...pluginUpdate,
    status: "error",
    reason: POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      {
        reason,
        message: "Updated plugin migrations could not be run in a fresh process.",
        guidance: ["Run `openclaw update repair` to retry post-update plugin repair."],
      },
    ],
  };
}

export async function runUpdateFinalizationDoctorInFreshProcess(params: {
  root: string;
  yes: boolean;
  json: boolean;
  timeoutMs: number;
  nodeRunner?: string;
  entryPath?: string;
}): Promise<void> {
  const entryPath = params.entryPath ?? (await resolveGatewayInstallEntrypoint(params.root));
  if (!entryPath) {
    throw new Error("Updated OpenClaw entrypoint not found for post-plugin doctor");
  }
  const args = [
    entryPath,
    "doctor",
    "--repair",
    "--non-interactive",
    "--no-workspace-suggestions",
    ...(params.yes ? ["--yes"] : []),
  ];
  const result = await runExec(params.nodeRunner ?? resolveNodeRunner(), args, {
    cwd: params.root,
    timeoutMs: params.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    logOutput: false,
    baseEnv: stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
    env: {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
      [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
    },
  });
  if (!params.json) {
    if (result.stdout.trim()) {
      defaultRuntime.log(result.stdout.trimEnd());
    }
    if (result.stderr.trim()) {
      defaultRuntime.error(result.stderr.trimEnd());
    }
  }
}

async function validatePostPluginConfigInFreshProcess(params: {
  root: string;
  timeoutMs: number;
  entryPath: string;
  nodeRunner?: string;
}): Promise<boolean> {
  try {
    await runExec(
      params.nodeRunner ?? resolveNodeRunner(),
      [params.entryPath, "config", "validate", "--json"],
      {
        cwd: params.root,
        timeoutMs: params.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        logOutput: false,
        baseEnv: stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function applyFreshPostPluginDoctor(params: {
  root: string;
  pluginUpdate: PostCorePluginUpdateResult;
  yes: boolean;
  json: boolean;
  timeoutMs: number;
  nodeRunner?: string;
}): Promise<{ pluginUpdate: PostCorePluginUpdateResult; configValid: boolean }> {
  let entryPath: string | undefined;
  try {
    entryPath = await resolveGatewayInstallEntrypoint(params.root);
  } catch (err) {
    return {
      pluginUpdate: createPostPluginDoctorExecutionFailure(params.pluginUpdate, String(err)),
      configValid: false,
    };
  }
  if (!entryPath) {
    return {
      pluginUpdate: createPostPluginDoctorExecutionFailure(
        params.pluginUpdate,
        "Updated OpenClaw entrypoint not found for post-plugin doctor",
      ),
      configValid: false,
    };
  }
  let pluginUpdate = params.pluginUpdate;
  try {
    await runUpdateFinalizationDoctorInFreshProcess({ ...params, entryPath });
  } catch (err) {
    pluginUpdate = createPostPluginDoctorExecutionFailure(params.pluginUpdate, String(err));
  }
  const configValid = await validatePostPluginConfigInFreshProcess({ ...params, entryPath });
  return { pluginUpdate, configValid };
}

export async function completePostCorePluginUpdate(params: {
  root: string;
  pluginUpdate: PostCorePluginUpdateResult;
  freshDoctorRequired: boolean;
  yes: boolean;
  json: boolean;
  timeoutMs: number;
  nodeRunner?: string;
}): Promise<{
  pluginUpdate: PostCorePluginUpdateResult;
  configSnapshot: ConfigFileSnapshot;
}> {
  let pluginUpdate = params.pluginUpdate;
  let freshConfigValid: boolean | undefined;
  if (pluginUpdate.status !== "error" && params.freshDoctorRequired) {
    // The current process can still hold the pre-update plugin and schema. Reload the updated
    // migration owner before trusting strict validation or restarting the gateway.
    const freshResult = await applyFreshPostPluginDoctor({
      root: params.root,
      pluginUpdate,
      yes: params.yes,
      json: params.json,
      timeoutMs: params.timeoutMs,
      ...(params.nodeRunner ? { nodeRunner: params.nodeRunner } : {}),
    });
    pluginUpdate = freshResult.pluginUpdate;
    freshConfigValid = freshResult.configValid;
  }

  const configSnapshot = await withNormalConfigValidation(() => readConfigFileSnapshot());
  // A plugin migration that did not converge must fail finalization instead of letting legacy
  // config reach the restarted gateway.
  // Two reads by design: the fresh child is the only process able to validate under the
  // UPDATED schema, so its verdict gates the restart; this parent snapshot is best-effort
  // state under the stale in-memory schema and the restarted gateway re-reads config anyway.
  pluginUpdate = applyPostPluginConfigValidation(
    pluginUpdate,
    freshConfigValid ?? configSnapshot.valid,
  );
  return { pluginUpdate, configSnapshot };
}
