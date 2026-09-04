/** Classifies systemd/systemctl unavailable errors into user-facing categories. */
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const SYSTEMD_INSPECTION_MESSAGES = {
  SYSTEMD_USER_BUS_UNAVAILABLE:
    "The systemd user D-Bus is unavailable. Check the service account's user bus and session environment; on Debian/Ubuntu, ensure dbus-user-session is installed and the user bus is running. See https://docs.openclaw.ai/gateway/doctor#linux-user-bus-inspection.",
  SYSTEMD_BUSCTL_UNAVAILABLE:
    "The systemd busctl utility could not be executed. Install or restore access to your distribution's busctl utility, then retry from the service account.",
} as const;

export function createSystemdInspectionError(
  code?: keyof typeof SYSTEMD_INSPECTION_MESSAGES,
): Error {
  // Native output and parser errors can contain service secrets. Never retain them as causes.
  return Object.assign(
    new Error(
      code
        ? SYSTEMD_INSPECTION_MESSAGES[code]
        : "Effective systemd service command could not be inspected.",
    ),
    { code },
  );
}

export function resolveSystemdInspectionDiagnostic(error: unknown): string | undefined {
  const code = extractErrorCode(error);
  // Reconstruct allowlisted text instead of trusting an error's message or nested cause.
  return Object.entries(SYSTEMD_INSPECTION_MESSAGES).find(([key]) => key === code)?.[1];
}

export type SystemdUnavailableKind =
  | "missing_systemctl"
  | "user_bus_unavailable"
  | "generic_unavailable";

// Normalizes platform command output before matching known systemd failure families.
function normalizeDetail(detail?: string): string {
  return normalizeLowercaseStringOrEmpty(detail);
}

export function isSystemctlMissingDetail(detail?: string): boolean {
  const normalized = normalizeDetail(detail);
  // A missing bus socket is not a missing executable. Cleanup must still attempt disable.
  if (isSystemdUserBusUnavailableDetail(normalized)) {
    return false;
  }
  return (
    normalized.includes("not found") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("spawn systemctl enoent") ||
    normalized.includes("spawn systemctl eacces") ||
    normalized.includes("systemctl not available")
  );
}

export function isSystemdUserBusUnavailableDetail(detail?: string): boolean {
  const normalized = normalizeDetail(detail);
  return (
    normalized.includes("failed to connect to bus") ||
    normalized.includes("failed to connect to user scope bus") ||
    normalized.includes("dbus_session_bus_address") ||
    normalized.includes("xdg_runtime_dir") ||
    normalized.includes("enomedium") ||
    normalized.includes("no medium found")
  );
}

export function classifySystemdUnavailableDetail(detail?: string): SystemdUnavailableKind | null {
  const normalized = normalizeDetail(detail);
  if (!normalized) {
    return null;
  }
  // Order matters: missing systemctl has different remediation from a live
  // systemd install whose user bus is unavailable.
  if (isSystemctlMissingDetail(normalized)) {
    return "missing_systemctl";
  }
  if (isSystemdUserBusUnavailableDetail(normalized)) {
    return "user_bus_unavailable";
  }
  if (
    normalized.includes("systemctl --user unavailable") ||
    normalized.includes("systemd user services are required") ||
    normalized.includes("not been booted with systemd") ||
    normalized.includes("not supported")
  ) {
    return "generic_unavailable";
  }
  return null;
}
