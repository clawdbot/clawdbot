// Runs post-plugin convergence checks without retaining pre-update plugin modules.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_POST_CORE_CONVERGENCE_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { buildUpdateDoctorEnv } from "../../infra/update-runner-doctor.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import { formatCommandOutput } from "../../process/command-error.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "../../utils/utf8-truncate.js";
import { resolveNodeRunner } from "./shared.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { applyPostPluginUpdateReadiness } from "./update-command-post-plugin-readiness.js";
import {
  applyPostPluginConfigValidation,
  POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
} from "./update-command-post-plugin-validation.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

type UpdateDoctorPhase = "pre-plugin" | "post-plugin";

export async function withPrePluginUpdateDoctorEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  const previousDeferConfiguredPluginInstallRepair =
    process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV];
  const previousParentSupportsDoctorConfigWrite =
    process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV];
  const previousPostCoreConvergence = process.env[UPDATE_POST_CORE_CONVERGENCE_ENV];
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV] = "1";
  process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] = "1";
  delete process.env[UPDATE_POST_CORE_CONVERGENCE_ENV];
  try {
    return await run();
  } finally {
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
    if (previousPostCoreConvergence === undefined) {
      delete process.env[UPDATE_POST_CORE_CONVERGENCE_ENV];
    } else {
      process.env[UPDATE_POST_CORE_CONVERGENCE_ENV] = previousPostCoreConvergence;
    }
  }
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
  phase: UpdateDoctorPhase;
  root: string;
  yes: boolean;
  json: boolean;
  workspaceSuggestions?: boolean;
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
    ...(params.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),
    ...(params.yes ? ["--yes"] : []),
  ];
  const baseEnv = stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env));
  delete baseEnv[UPDATE_POST_CORE_CONVERGENCE_ENV];
  let result: { stdout?: unknown; stderr?: unknown } | undefined;
  try {
    result = await runExec(params.nodeRunner ?? resolveNodeRunner(), args, {
      cwd: params.root,
      timeoutMs: params.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      logOutput: false,
      baseEnv,
      env: {
        // The outer updater owns service refresh and activation after every
        // migration finishes; a fresh Doctor must not resume its parked service.
        ...buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          deferConfiguredPluginInstallRepair: true,
        }),
        ...(params.phase === "post-plugin" ? { [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1" } : {}),
      },
    });
  } catch (error) {
    if (isRecord(error)) {
      result = error;
    }
    const redaction = { env: process.env, stateDir: resolveStateDir() };
    const details = (["stderr", "stdout"] as const).flatMap((stream) => {
      const output = result?.[stream];
      if (typeof output !== "string" || !output.trim()) {
        return [];
      }
      // Execa's message starts with full argv. Keep both actual diagnostics before
      // the bounded update handoff, without cutting a credential before redaction.
      const redacted = redactSupportString(output, redaction, {
        maxLength: Number.MAX_SAFE_INTEGER,
      });
      const formatted = formatCommandOutput(redacted, 384);
      let excerpt = formatted;
      if (Buffer.byteLength(redacted) > 384 || Buffer.byteLength(formatted) > 384) {
        const beginning = formatCommandOutput(truncateUtf8Prefix(redacted, 256), 256);
        excerpt = `${truncateUtf8Prefix(beginning, 256)}\n...\n${truncateUtf8Suffix(formatted, 123)}`;
      }
      return excerpt ? [`${stream}: ${excerpt}`] : [];
    });
    if (details.length > 0) {
      throw new Error(`Updated ${params.phase} Doctor failed:\n${details.join("\n")}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    // Clack writes directly to the child's stdout. Preserve diagnostics on either
    // exit path without letting them share the parent's JSON result stream.
    if (typeof result?.stdout === "string" && result.stdout.trim()) {
      defaultRuntime[params.json ? "error" : "log"](result.stdout.trimEnd());
    }
    if (typeof result?.stderr === "string" && result.stderr.trim()) {
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
    await runUpdateFinalizationDoctorInFreshProcess({
      ...params,
      entryPath,
      phase: "post-plugin",
    });
  } catch (err) {
    pluginUpdate = createPostPluginDoctorExecutionFailure(params.pluginUpdate, String(err));
  }
  const configValid = await validatePostPluginConfigInFreshProcess({ ...params, entryPath });
  if (configValid) {
    pluginUpdate = await applyPostPluginUpdateReadiness({
      root: params.root,
      entryPath,
      pluginUpdate,
      timeoutMs: params.timeoutMs,
      ...(params.nodeRunner ? { nodeRunner: params.nodeRunner } : {}),
    });
  }
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
  } else if (pluginUpdate.status !== "error") {
    pluginUpdate = await applyPostPluginUpdateReadiness({
      root: params.root,
      pluginUpdate,
      timeoutMs: params.timeoutMs,
      ...(params.nodeRunner ? { nodeRunner: params.nodeRunner } : {}),
    });
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
