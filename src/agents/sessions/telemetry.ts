import type { SettingsManager } from "./settings-manager.js";

/**
 * Install telemetry switch shared by session startup and settings.
 *
 * Environment overrides win over persisted settings so CI and packaged launchers
 * can force the telemetry posture without editing user config.
 */
function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Resolves whether install telemetry is enabled from env override or settings. */
export function isInstallTelemetryEnabled(
  settingsManager: SettingsManager,
  telemetryEnv: string | undefined = process.env.OPENCLAW_TELEMETRY,
): boolean {
  return telemetryEnv !== undefined
    ? isTruthyEnvFlag(telemetryEnv)
    : settingsManager.getEnableInstallTelemetry();
}
