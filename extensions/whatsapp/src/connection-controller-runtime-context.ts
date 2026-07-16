// Whatsapp plugin module exposes live connection controllers through the channel runtime.
import type { WASocket } from "baileys";
import { getChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { WhatsAppSelfIdentity } from "./identity.js";
import type { ActiveWebListener } from "./inbound/types.js";
import { getOptionalWhatsAppRuntime } from "./runtime.js";

export const WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY = "connection-controller";

type WhatsAppConnectionControllerHandle = {
  getActiveListener(): ActiveWebListener | null;
  getCurrentSock(): WASocket | null;
  getSelfIdentity(): WhatsAppSelfIdentity | null;
};

export function getWhatsAppConnectionController(
  accountId: string,
): WhatsAppConnectionControllerHandle | null {
  const context = getChannelRuntimeContext({
    channelRuntime: getOptionalWhatsAppRuntime()?.channel,
    channelId: "whatsapp",
    accountId,
    capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
  });
  return (context as WhatsAppConnectionControllerHandle | undefined) ?? null;
}
