export const TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS = 45_000;
const TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS = 60_000;

const TELEGRAM_REQUEST_TIMEOUTS_MS = {
  // Bound startup/control-plane calls so the gateway cannot report Telegram as
  // healthy while provider startup is still hung on Bot API setup.
  deletemycommands: 15_000,
  deletewebhook: 15_000,
  deletemessage: 15_000,
  editforumtopic: 15_000,
  editmessagetext: 15_000,
  getchat: 15_000,
  getfile: 30_000,
  getme: 15_000,
  getupdates: TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS,
  pinchatmessage: 15_000,
  sendanimation: 30_000,
  sendaudio: 30_000,
  sendchataction: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
  senddocument: 30_000,
  sendmessage: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
  sendmessagedraft: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
  sendphoto: 30_000,
  sendvideo: 30_000,
  sendvoice: 30_000,
  setmessagereaction: 10_000,
  setmycommands: 15_000,
  setwebhook: 15_000,
} as const;

function resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return undefined;
  }
  return Math.max(1, Math.floor(timeoutSeconds)) * 1000;
}

export function resolveTelegramRequestTimeoutMs(
  method: string | null,
  timeoutSeconds?: unknown,
): number | undefined {
  if (!method) {
    return undefined;
  }
  const baseTimeoutMs =
    TELEGRAM_REQUEST_TIMEOUTS_MS[method as keyof typeof TELEGRAM_REQUEST_TIMEOUTS_MS];
  if (baseTimeoutMs === undefined || method === "getupdates") {
    return baseTimeoutMs;
  }
  return Math.max(baseTimeoutMs, resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) ?? 0);
}

export function resolveTelegramStartupProbeTimeoutMs(timeoutSeconds: unknown): number {
  const getMeTimeoutMs = resolveTelegramRequestTimeoutMs("getme") ?? 15_000;
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return getMeTimeoutMs;
  }
  const configuredTimeoutMs = Math.max(1, Math.floor(timeoutSeconds)) * 1000;
  return Math.max(getMeTimeoutMs, configuredTimeoutMs);
}
