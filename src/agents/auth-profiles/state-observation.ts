/**
 * Structured logging for auth profile failure state changes.
 * Log payloads keep machine-readable fields while redacting console-facing ids.
 */
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeForConsole } from "../console-sanitize.js";
import type { AuthProfileFailureReason, ProfileUsageStats } from "./types.js";

const observationLog = createSubsystemLogger("agent/embedded");

/** Logs an auth profile failure/cooldown/disable state transition. */
export function logAuthProfileFailureStateChange(params: {
  runId?: string;
  profileId: string;
  provider: string;
  reason: AuthProfileFailureReason;
  previous: ProfileUsageStats | undefined;
  next: ProfileUsageStats;
  now: number;
}): void {
  const windowType =
    params.reason === "billing" || params.reason === "auth_permanent" ? "disabled" : "cooldown";
  const previousCooldownUntil = params.previous?.cooldownUntil;
  const previousDisabledUntil = params.previous?.disabledUntil;
  // Active cooldown/disable windows are intentionally immutable; log whether
  // this update reused the existing window instead of extending it.
  const windowReused =
    windowType === "disabled"
      ? typeof previousDisabledUntil === "number" &&
        Number.isFinite(previousDisabledUntil) &&
        previousDisabledUntil > params.now &&
        previousDisabledUntil === params.next.disabledUntil
      : typeof previousCooldownUntil === "number" &&
        Number.isFinite(previousCooldownUntil) &&
        previousCooldownUntil > params.now &&
        previousCooldownUntil === params.next.cooldownUntil;
  const safeProfileId = redactIdentifier(params.profileId, { len: 12 });
  const safeRunId = sanitizeForConsole(params.runId) ?? "-";
  const safeProvider = sanitizeForConsole(params.provider) ?? "-";

  observationLog.warn("auth profile failure state updated", {
    event: "auth_profile_failure_state_updated",
    tags: ["error_handling", "auth_profiles", windowType],
    runId: params.runId,
    profileId: safeProfileId,
    provider: params.provider,
    reason: params.reason,
    windowType,
    windowReused,
    previousErrorCount: params.previous?.errorCount,
    errorCount: params.next.errorCount,
    previousCooldownUntil,
    cooldownUntil: params.next.cooldownUntil,
    previousDisabledUntil,
    disabledUntil: params.next.disabledUntil,
    previousDisabledReason: params.previous?.disabledReason,
    disabledReason: params.next.disabledReason,
    failureCounts: params.next.failureCounts,
    consoleMessage:
      `auth profile failure state updated: runId=${safeRunId} profile=${safeProfileId} provider=${safeProvider} ` +
      `reason=${params.reason} window=${windowType} reused=${String(windowReused)}`,
  });
}
