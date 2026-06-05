/** Detects whether the current process is running inside a launchd service label. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type CurrentProcessLaunchdServiceLabelOptions = {
  allowConfiguredLabelFallback?: boolean;
};

/** Checks whether the current process appears to be running under the requested launchd label. */
export function isCurrentProcessLaunchdServiceLabel(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CurrentProcessLaunchdServiceLabelOptions = {},
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

  const configuredLabel = normalizeOptionalString(env.OPENCLAW_LAUNCHD_LABEL);
  if (!configuredLabel || configuredLabel !== label) {
    return false;
  }
  if (
    normalizeOptionalString(env.OPENCLAW_SERVICE_MARKER) === "openclaw" &&
    Boolean(normalizeOptionalString(env.OPENCLAW_SERVICE_KIND))
  ) {
    // Managed wrappers inject service metadata; trust it when launchd's own
    // label variables are absent or renamed by the host environment.
    return true;
  }
  return options.allowConfiguredLabelFallback !== false && currentLabels.length === 0;
}
