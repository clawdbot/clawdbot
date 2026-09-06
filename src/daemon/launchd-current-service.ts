/** Detects launchd service membership from environment markers or process ancestry. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getSelfAndAncestorPidsSync } from "../infra/restart-stale-pids.js";
import { probeLaunchAgentState, resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";

/** Checks whether the current process appears to be running under the requested launchd label. */
export function isCurrentProcessLaunchdServiceLabel(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const currentLabels = [env.LAUNCH_JOB_LABEL, env.LAUNCH_JOB_NAME, env.XPC_SERVICE_NAME].flatMap(
    (value) => {
      const normalized = normalizeOptionalString(value);
      return normalized ? [normalized] : [];
    },
  );

  for (const currentLabel of currentLabels) {
    if (currentLabel === label) {
      return true;
    }
  }

  // Detached update/restart handoffs keep OPENCLAW_LAUNCHD_LABEL as the service
  // identity to manage while running outside the job, so the configured label
  // alone never proves membership: a restart that trusted it would schedule a
  // detached handoff instead of restarting and health-proving the service.
  // Managed wrappers inject the service marker; trust it when launchd's own
  // label variables are absent or renamed by the host environment.
  return (
    normalizeOptionalString(env.OPENCLAW_LAUNCHD_LABEL) === label &&
    normalizeOptionalString(env.OPENCLAW_SERVICE_MARKER) === "openclaw" &&
    Boolean(normalizeOptionalString(env.OPENCLAW_SERVICE_KIND))
  );
}

/**
 * Env markers are the fast path. A hand-written plist can omit them, so the PID
 * launchd reports for the job is checked against the caller's ancestry instead.
 * The detached update helper's recovery CLI inherits OPENCLAW_LAUNCHD_LABEL but
 * descends from no running Gateway, so it stays on the synchronous path.
 */
export async function isCurrentProcessInsideLaunchdService(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isCurrentProcessLaunchdServiceLabel(label, env)) {
    return true;
  }
  // Probe failures resolve to "unknown"; only a running job has a PID to be inside.
  const probe = await probeLaunchAgentState(`${resolveLaunchAgentGuiDomain()}/${label}`);
  if (probe.state !== "running" || probe.runtime.pid === undefined) {
    return false;
  }
  return getSelfAndAncestorPidsSync().has(probe.runtime.pid);
}
