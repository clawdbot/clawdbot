import { consumeAuthenticatedChannelAdministratorSource } from "../channels/message-access/admission-evidence.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { isConfiguredCommandOwner } from "./command-auth.js";

/** Called only for a fresh owner turn, never from route metadata or model arguments. */
export function admitChannelAdministratorPolicy(
  context: object,
  config: OpenClawConfig,
): (() => void) | undefined {
  const source = consumeAuthenticatedChannelAdministratorSource(context);
  if (!source) {
    return undefined;
  }
  const matches = (cfg: OpenClawConfig) =>
    source.channel === "discord" &&
    cfg.commands?.channelAdministrators?.some(
      (grant) =>
        grant.channel === source.channel &&
        grant.accountId === source.accountId &&
        grant.senderId === source.senderId &&
        grant.conversationId === source.conversationId,
    ) === true &&
    isConfiguredCommandOwner(cfg, {
      channel: source.channel,
      accountId: source.accountId,
      senderId: source.senderId,
    });
  if (!matches(config)) {
    return undefined;
  }
  const assertActive = () => {
    source.assertActive();
    if (!matches(getRuntimeConfig())) {
      throw new Error("Trusted channel administrator grant or command ownership was revoked.");
    }
  };
  assertActive();
  return assertActive;
}
