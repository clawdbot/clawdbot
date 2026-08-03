// Doctor startup channel maintenance runs channel plugin startup repairs.
import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import { resolveDoctorChannelPreviewConfig } from "../commands/doctor/shared/preview-warnings.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "./health-checks.js";

const CHANNEL_PREVIEW_WARNINGS_CHECK_ID = "core/doctor/channel-preview-warnings";

// Doctor wrapper for plugin startup maintenance repairs.
type DoctorStartupMaintenanceRuntime = {
  error: (message: string) => void;
  log: (message: string) => void;
};

type ChannelPluginStartupMaintenanceRunner = typeof runChannelPluginStartupMaintenance;

function normalizeWarningMessage(warning: string): string {
  return warning.replace(/^-\s*/, "").trim();
}

function warningPath(warning: string): string | undefined {
  return warning.match(/^\s*-?\s*(channels\.[^\s:]+)/)?.[1];
}

/** Collect read-only channel doctor preview warnings as structured findings. */
export async function collectChannelPreviewWarningHealthFindings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand?: string;
  env?: NodeJS.ProcessEnv;
  allowExec?: boolean;
}): Promise<readonly HealthFinding[]> {
  const { collectChannelDoctorPreviewWarnings } =
    await import("../commands/doctor/shared/channel-doctor.js");
  const doctorFixCommand = params.doctorFixCommand ?? "openclaw doctor --fix";
  const previewConfig = await resolveDoctorChannelPreviewConfig({
    cfg: params.cfg,
    env: params.env ?? process.env,
    allowExec: params.allowExec,
  });
  const warnings = await collectChannelDoctorPreviewWarnings({
    cfg: previewConfig.cfg,
    doctorFixCommand,
    env: params.env ?? process.env,
  });
  return warnings.map((warning): HealthFinding => {
    const path = warningPath(warning);
    const baseFinding = {
      checkId: CHANNEL_PREVIEW_WARNINGS_CHECK_ID,
      severity: "warning",
      message: normalizeWarningMessage(warning),
      requirement: "Configured channels should not emit doctor preview warnings.",
      fixHint: `Run \`${doctorFixCommand}\` if the channel warning recommends repair, or update the affected channel config manually.`,
    } satisfies HealthFinding;
    if (path) {
      return {
        checkId: baseFinding.checkId,
        severity: baseFinding.severity,
        message: baseFinding.message,
        path,
        requirement: baseFinding.requirement,
        fixHint: baseFinding.fixHint,
      };
    }
    return baseFinding;
  });
}

/** Runs channel plugin startup maintenance when doctor fix mode explicitly permits repairs. */
export async function maybeRunDoctorStartupChannelMaintenance(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runChannelPluginStartupMaintenance?: ChannelPluginStartupMaintenanceRunner;
  runtime: DoctorStartupMaintenanceRuntime;
  shouldRepair: boolean;
}): Promise<void> {
  if (!params.shouldRepair) {
    return;
  }
  const runStartupMaintenance =
    params.runChannelPluginStartupMaintenance ?? runChannelPluginStartupMaintenance;
  await runStartupMaintenance({
    cfg: params.cfg,
    env: params.env ?? process.env,
    // Doctor maps startup warnings to terminal errors so repair output is visible.
    log: {
      info: (message) => params.runtime.log(message),
      warn: (message) => params.runtime.error(message),
    },
    trigger: "doctor-fix",
    logPrefix: "doctor",
  });
}
