import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

/** Android stamps this prefix on its node main session; it is not a user rename. */
const PLATFORM_AUTO_SESSION_LABEL_RE = /^OpenClaw App(?:\s*·|$)/i;

function resolveNodeDeviceId12(sessionKey?: string): string | undefined {
  const rest = parseAgentSessionKey(sessionKey)?.rest ?? "";
  if (!rest.startsWith("node-")) {
    return undefined;
  }
  const deviceId = rest.slice("node-".length).split(":")[0];
  return deviceId || undefined;
}

/** True when label is Android's node connect stamp for this session key. */
export function isPlatformAutoSessionLabel(
  value: string | null | undefined,
  sessionKey?: string,
): boolean {
  const trimmed = value?.trim();
  const deviceId = resolveNodeDeviceId12(sessionKey);
  if (!trimmed || !deviceId) {
    return false;
  }
  if (/^OpenClaw App$/i.test(trimmed)) {
    return true;
  }
  if (trimmed.toLowerCase() === `openclaw app · ${deviceId}`.toLowerCase()) {
    return true;
  }
  return PLATFORM_AUTO_SESSION_LABEL_RE.test(trimmed) && trimmed.endsWith(` · ${deviceId}`);
}
