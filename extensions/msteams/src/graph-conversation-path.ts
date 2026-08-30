import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveDefaultMSTeamsAccountId } from "./accounts.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";

function stripTargetPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (/^conversation:/i.test(trimmed)) {
    return trimmed.slice("conversation:".length).trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.slice("user:".length).trim();
  }
  return trimmed;
}

export async function resolveGraphConversationId(
  to: string,
  options?: { accountId?: string | null; cfg?: OpenClawConfig },
): Promise<string> {
  const trimmed = to.trim();
  const isUserTarget = /^user:/i.test(trimmed);
  const cleaned = stripTargetPrefix(trimmed);
  if (!isUserTarget) {
    return cleaned;
  }

  const accountId = normalizeAccountId(
    options?.accountId ??
      (options?.cfg ? resolveDefaultMSTeamsAccountId(options.cfg) : DEFAULT_ACCOUNT_ID),
  );
  const store = createMSTeamsConversationStoreState({ accountId });
  const found = await store.findPreferredDmByUserId(cleaned);
  if (!found) {
    throw new Error(
      `No conversation found for user:${cleaned}. ` +
        "The bot must receive a message from this user before Graph API operations work.",
    );
  }
  if (found.conversationId.startsWith("19:")) {
    return found.conversationId;
  }
  throw new Error(
    `Conversation for user:${cleaned} uses a Bot Framework ID (${found.conversationId}) ` +
      "that Graph API does not accept. Use a Graph-native conversation:19:... target when available.",
  );
}

export function resolveConversationPath(to: string): {
  kind: "chat" | "channel";
  basePath: string;
  chatId?: string;
  teamId?: string;
  channelId?: string;
} {
  const cleaned = stripTargetPrefix(to);
  const separatorIndex = cleaned.indexOf("/");
  if (separatorIndex !== -1) {
    const teamId = cleaned.slice(0, separatorIndex);
    const channelId = cleaned.slice(separatorIndex + 1).replace(/\/.*$/, "");
    return {
      kind: "channel",
      basePath: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`,
      teamId,
      channelId,
    };
  }
  return {
    kind: "chat",
    basePath: `/chats/${encodeURIComponent(cleaned)}`,
    chatId: cleaned,
  };
}
