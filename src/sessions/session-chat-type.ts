import { iterateBootstrapChannelPlugins } from "../channels/plugins/bootstrap-registry.js";
import {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "./session-chat-type-shared.js";

export {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "./session-chat-type-shared.js";

export function deriveSessionChatType(sessionKey: string | undefined | null): SessionKeyChatType {
  const builtInType = deriveSessionChatTypeFromKey(sessionKey);
  if (builtInType !== "unknown") {
    return builtInType;
  }

  return deriveSessionChatTypeFromKey(
    sessionKey,
    Array.from(iterateBootstrapChannelPlugins())
      .map((plugin) => plugin.messaging?.deriveLegacySessionChatType)
      .filter(
        (
          deriveLegacySessionChatType,
        ): deriveLegacySessionChatType is NonNullable<typeof deriveLegacySessionChatType> =>
          Boolean(deriveLegacySessionChatType),
      ),
  );
}
