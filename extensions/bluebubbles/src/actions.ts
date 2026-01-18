import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionName,
  type ChannelToolSend,
  type ClawdbotConfig,
} from "clawdbot/plugin-sdk";

import { resolveBlueBubblesAccount } from "./accounts.js";
import { sendBlueBubblesReaction } from "./reactions.js";
import { resolveChatGuidForTarget } from "./send.js";
import { normalizeBlueBubblesHandle, parseBlueBubblesTarget } from "./targets.js";
import type { BlueBubblesSendTarget } from "./types.js";

const providerId = "bluebubbles";

function mapTarget(raw: string): BlueBubblesSendTarget {
  const parsed = parseBlueBubblesTarget(raw);
  if (parsed.kind === "chat_guid") return { kind: "chat_guid", chatGuid: parsed.chatGuid };
  if (parsed.kind === "chat_id") return { kind: "chat_id", chatId: parsed.chatId };
  if (parsed.kind === "chat_identifier") {
    return { kind: "chat_identifier", chatIdentifier: parsed.chatIdentifier };
  }
  return {
    kind: "handle",
    address: normalizeBlueBubblesHandle(parsed.to),
    service: parsed.service,
  };
}

export const bluebubblesMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const account = resolveBlueBubblesAccount({ cfg: cfg as ClawdbotConfig });
    if (!account.enabled || !account.configured) return [];
    const gate = createActionGate((cfg as ClawdbotConfig).channels?.bluebubbles?.actions);
    const actions = new Set<ChannelMessageActionName>();
    if (gate("reactions")) actions.add("react");
    return Array.from(actions);
  },
  supportsAction: ({ action }) => action === "react",
  extractToolSend: ({ args }): ChannelToolSend | null => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) return null;
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action !== "react") {
      throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
    }
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a BlueBubbles reaction.",
    });
    if (isEmpty && !remove) {
      throw new Error("Emoji is required to send a BlueBubbles reaction.");
    }
    const messageId = readStringParam(params, "messageId", { required: true });
    const chatGuid = readStringParam(params, "chatGuid");
    const chatIdentifier = readStringParam(params, "chatIdentifier");
    const chatId = readNumberParam(params, "chatId", { integer: true });
    const to = readStringParam(params, "to");
    const partIndex = readNumberParam(params, "partIndex", { integer: true });

    const account = resolveBlueBubblesAccount({
      cfg: cfg as ClawdbotConfig,
      accountId: accountId ?? undefined,
    });
    const baseUrl = account.config.serverUrl?.trim();
    const password = account.config.password?.trim();

    let resolvedChatGuid = chatGuid?.trim() || "";
    if (!resolvedChatGuid) {
      const target =
        chatIdentifier?.trim()
          ? ({ kind: "chat_identifier", chatIdentifier: chatIdentifier.trim() } as BlueBubblesSendTarget)
          : typeof chatId === "number"
            ? ({ kind: "chat_id", chatId } as BlueBubblesSendTarget)
            : to
              ? mapTarget(to)
              : null;
      if (!target) {
        throw new Error("BlueBubbles reaction requires chatGuid, chatIdentifier, chatId, or to.");
      }
      if (!baseUrl || !password) {
        throw new Error("BlueBubbles reaction requires serverUrl and password.");
      }
      resolvedChatGuid =
        (await resolveChatGuidForTarget({
          baseUrl,
          password,
          target,
        })) ?? "";
    }
    if (!resolvedChatGuid) {
      throw new Error("BlueBubbles reaction failed: chatGuid not found for target.");
    }

    await sendBlueBubblesReaction({
      chatGuid: resolvedChatGuid,
      messageGuid: messageId,
      emoji,
      remove: remove || undefined,
      partIndex: typeof partIndex === "number" ? partIndex : undefined,
      opts: {
        cfg: cfg as ClawdbotConfig,
        accountId: accountId ?? undefined,
      },
    });

    if (!remove) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  },
};
