import type { PairingProvider } from "./pairing-store.js";

export const PROVIDER_ID_LABELS: Record<PairingProvider, string> = {
  telegram: "telegramUserId",
  discord: "discordUserId",
  slack: "slackUserId",
  signal: "signalNumber",
  imessage: "imessageSenderId",
  whatsapp: "whatsappSenderId",
  msteams: "msteamsUserId",
};
