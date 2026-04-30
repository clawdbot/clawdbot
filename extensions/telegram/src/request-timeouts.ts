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
  getupdates: 45_000,
  pinchatmessage: 15_000,
  sendanimation: 30_000,
  sendaudio: 30_000,
  sendchataction: 10_000,
  senddocument: 30_000,
  sendmessage: 20_000,
  sendmessagedraft: 20_000,
  sendphoto: 30_000,
  sendvideo: 30_000,
  sendvoice: 30_000,
  setmessagereaction: 10_000,
  setmycommands: 15_000,
  setwebhook: 15_000,
} as const;

export function resolveTelegramRequestTimeoutMs(method: string | null): number | undefined {
  if (!method) {
    return undefined;
  }
  return TELEGRAM_REQUEST_TIMEOUTS_MS[method as keyof typeof TELEGRAM_REQUEST_TIMEOUTS_MS];
}
