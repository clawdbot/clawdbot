import { note } from "../../packages/terminal-core/src/note.js";
import type { PluginPayloadSmokeFailure } from "../cli/update-cli/plugin-payload-validation.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  formatPluginVerificationDiagnostic,
  type DegradedPlugin,
} from "../plugins/runtime-degraded-state.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";

type StartupPluginVerificationDiagnostic = {
  kind: "plugin-verification";
  messages: string[];
};

type StartupPluginConvergenceResult = {
  blockingDiagnostic: StartupPluginVerificationDiagnostic | null;
  quarantinedPlugins: DegradedPlugin[];
};

async function planStartupPluginVerification(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
}) {
  const { planStartupPluginConvergence } = await measureDoctorConfigPreflightStep(
    "plugin-plan-import",
    () => import("./doctor/shared/startup-plugin-convergence-plan.js"),
    params.measure,
  );
  return await measureDoctorConfigPreflightStep(
    "plugin-plan",
    () =>
      planStartupPluginConvergence({
        config: params.cfg,
        env: params.env,
      }),
    params.measure,
  );
}

function isStartupPluginVerificationFailureActive(params: {
  cfg: OpenClawConfig;
  failure: PluginPayloadSmokeFailure;
}): boolean {
  return resolveEffectiveEnableState({
    id: params.failure.pluginId,
    origin: "global",
    config: normalizePluginsConfig(params.cfg.plugins),
    rootConfig: params.cfg,
  }).enabled;
}

function buildStartupPluginQuarantine(params: {
  cfg: OpenClawConfig;
  failures: readonly PluginPayloadSmokeFailure[];
}): DegradedPlugin[] {
  return buildDegradedPluginsFromVerificationFailures(
    params.failures.filter(
      (failure) =>
        Boolean(failure.installPath) &&
        isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
    ),
  );
}

function formatStartupPluginSmokeFailure(failure: PluginPayloadSmokeFailure): string {
  return `Plugin "${failure.pluginId}": ${formatPluginVerificationDiagnostic({
    kind: "plugin-verification",
    reason: failure.reason,
    detail: failure.detail,
    ...(failure.installPath ? { installPath: failure.installPath } : {}),
  })}. Run \`openclaw update repair\` to retry plugin repair.`;
}

export async function runStartupUpgradeConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
}): Promise<StartupPluginConvergenceResult> {
  const plan = await planStartupPluginVerification(params);
  if (!plan.required) {
    return { blockingDiagnostic: null, quarantinedPlugins: [] };
  }
  const { runPostCorePluginConvergence } = await measureDoctorConfigPreflightStep(
    "plugin-convergence-import",
    () => import("../cli/update-cli/post-core-plugin-convergence.js"),
    params.measure,
  );
  const convergence = await measureDoctorConfigPreflightStep(
    "plugin-convergence",
    () =>
      runPostCorePluginConvergence({
        cfg: params.cfg,
        env: params.env,
        baselineInstallRecords: plan.installRecords,
      }),
    params.measure,
  );
  if (convergence.changes.length > 0) {
    note(convergence.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  const notices = convergence.notices ?? [];
  if (notices.length > 0) {
    note(
      notices.map((notice) => `- ${notice.message} ${notice.guidance.join(" ")}`.trim()).join("\n"),
      "Doctor notices",
    );
  }
  const warnings = convergence.warnings.map((warning) =>
    `${warning.message} ${warning.guidance.join(" ")}`.trim(),
  );
  if (warnings.length > 0) {
    note(warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  const quarantinedPlugins = buildStartupPluginQuarantine({
    cfg: params.cfg,
    failures: convergence.smokeFailures,
  });
  const nonBlockingWarningKeys = new Set(
    convergence.smokeFailures
      .filter(
        (failure) =>
          Boolean(failure.installPath) ||
          !isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
      )
      .map((failure) => JSON.stringify([failure.pluginId, `${failure.reason}: ${failure.detail}`])),
  );
  const blockingMessages = convergence.warnings
    .filter(
      (warning) =>
        !warning.pluginId ||
        !nonBlockingWarningKeys.has(JSON.stringify([warning.pluginId, warning.reason])),
    )
    .map((warning) => `${warning.message} ${warning.guidance.join(" ")}`.trim());
  return {
    blockingDiagnostic:
      blockingMessages.length > 0
        ? { kind: "plugin-verification", messages: blockingMessages }
        : null,
    quarantinedPlugins,
  };
}

export async function refreshStartupPluginQuarantine(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
}): Promise<StartupPluginConvergenceResult> {
  const plan = await planStartupPluginVerification(params);
  if (!plan.required) {
    return { blockingDiagnostic: null, quarantinedPlugins: [] };
  }
  const { runActivePluginPayloadSmokeCheck } = await measureDoctorConfigPreflightStep(
    "plugin-payload-verification-import",
    () => import("../cli/update-cli/active-plugin-payload-validation.js"),
    params.measure,
  );
  const smoke = await measureDoctorConfigPreflightStep(
    "plugin-payload-verification",
    () =>
      runActivePluginPayloadSmokeCheck({
        cfg: params.cfg,
        records: plan.installRecords,
        env: params.env,
      }),
    params.measure,
  );
  const result = mapStartupPluginQuarantineRefresh({
    cfg: params.cfg,
    failures: smoke.failures,
  });
  if (result.quarantinedPlugins.length > 0) {
    note(
      result.quarantinedPlugins
        .map(
          (plugin) =>
            `- ${formatStartupPluginSmokeFailure({
              pluginId: plugin.pluginId,
              reason: plugin.diagnostic.reason,
              detail: plugin.diagnostic.detail,
              ...(plugin.diagnostic.installPath
                ? { installPath: plugin.diagnostic.installPath }
                : {}),
            })}`,
        )
        .join("\n"),
      "Doctor warnings",
    );
  }
  return result;
}

function mapStartupPluginQuarantineRefresh(params: {
  cfg: OpenClawConfig;
  failures: readonly PluginPayloadSmokeFailure[];
}): StartupPluginConvergenceResult {
  const quarantinedPlugins = buildStartupPluginQuarantine(params);
  const blockingFailures = params.failures.filter(
    (failure) =>
      !failure.installPath &&
      isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
  );
  return {
    blockingDiagnostic:
      blockingFailures.length > 0
        ? {
            kind: "plugin-verification",
            messages: blockingFailures.map(formatStartupPluginSmokeFailure),
          }
        : null,
    quarantinedPlugins,
  };
}

export function formatStartupPluginVerificationFailure(
  diagnostic: StartupPluginVerificationDiagnostic,
): string {
  return [
    "OpenClaw plugin verification failed; refusing to report the gateway ready.",
    ...diagnostic.messages.map((message) => `- ${message}`),
    "Resolve the plugin verification errors above, then restart the container.",
  ].join("\n");
}
