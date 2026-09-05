/** Detects whether the current process is running inside a launchd service label. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

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
