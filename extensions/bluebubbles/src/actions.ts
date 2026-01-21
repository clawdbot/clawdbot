import {
  BLUEBUBBLES_ACTION_NAMES,
  BLUEBUBBLES_ACTIONS,
  createActionGate,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readReactionParams,
  readStringParam,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionName,
  type ChannelToolSend,
  type ClawdbotConfig,
} from "clawdbot/plugin-sdk";

import { resolveBlueBubblesAccount } from "./accounts.js";
import { resolveBlueBubblesMessageId } from "./monitor.js";
import { isMacOS26OrHigher } from "./probe.js";
import { sendBlueBubblesReaction } from "./reactions.js";
import { resolveChatGuidForTarget, sendMessageBlueBubbles } from "./send.js";
import {
  editBlueBubblesMessage,
  unsendBlueBubblesMessage,
  renameBlueBubblesChat,
  setGroupIconBlueBubbles,
  addBlueBubblesParticipant,
  removeBlueBubblesParticipant,
  leaveBlueBubblesChat,
} from "./chat.js";
import { sendBlueBubblesAttachment } from "./attachments.js";
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

function readMessageText(params: Record<string, unknown>): string | undefined {
  return readStringParam(params, "text") ?? readStringParam(params, "message");
}

/** Supported action names for BlueBubbles */
const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>(BLUEBUBBLES_ACTION_NAMES);

export const bluebubblesMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const account = resolveBlueBubblesAccount({ cfg: cfg as ClawdbotConfig });
    if (!account.enabled || !account.configured) return [];
    const gate = createActionGate((cfg as ClawdbotConfig).channels?.bluebubbles?.actions);
    const actions = new Set<ChannelMessageActionName>();
    const macOS26 = isMacOS26OrHigher(account.accountId);
    for (const action of BLUEBUBBLES_ACTION_NAMES) {
      const spec = BLUEBUBBLES_ACTIONS[action];
      if (!spec?.gate) continue;
      if (spec.unsupportedOnMacOS26 && macOS26) continue;
      if (gate(spec.gate)) actions.add(action);
    }
    return Array.from(actions);
  },
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  extractToolSend: ({ args }): ChannelToolSend | null => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) return null;
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    const account = resolveBlueBubblesAccount({
      cfg: cfg as ClawdbotConfig,
      accountId: accountId ?? undefined,
    });
    const baseUrl = account.config.serverUrl?.trim();
    const password = account.config.password?.trim();
    const opts = { cfg: cfg as ClawdbotConfig, accountId: accountId ?? undefined };

    // Helper to resolve chatGuid from various params or session context
    const resolveChatGuid = async (): Promise<string> => {
      const chatGuid = readStringParam(params, "chatGuid");
      if (chatGuid?.trim()) return chatGuid.trim();

      const chatIdentifier = readStringParam(params, "chatIdentifier");
      const chatId = readNumberParam(params, "chatId", { integer: true });
      const to = readStringParam(params, "to");
      // Fall back to session context if no explicit target provided
      const contextTarget = toolContext?.currentChannelId?.trim();

      const target = chatIdentifier?.trim()
        ? ({
            kind: "chat_identifier",
            chatIdentifier: chatIdentifier.trim(),
          } as BlueBubblesSendTarget)
        : typeof chatId === "number"
          ? ({ kind: "chat_id", chatId } as BlueBubblesSendTarget)
          : to
            ? mapTarget(to)
            : contextTarget
              ? mapTarget(contextTarget)
              : null;

      if (!target) {
        throw new Error(`BlueBubbles ${action} requires chatGuid, chatIdentifier, chatId, or to.`);
      }
      if (!baseUrl || !password) {
        throw new Error(`BlueBubbles ${action} requires serverUrl and password.`);
      }

      const resolved = await resolveChatGuidForTarget({ baseUrl, password, target });
      if (!resolved) {
        throw new Error(`BlueBubbles ${action} failed: chatGuid not found for target.`);
      }
      return resolved;
    };

    // Handle react action
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a BlueBubbles reaction.",
      });
      if (isEmpty && !remove) {
        throw new Error(
          "BlueBubbles react requires emoji parameter. Use action=react with emoji=<emoji> and messageId=<message_id>.",
        );
      }
      const rawMessageId = readStringParam(params, "messageId");
      if (!rawMessageId) {
        throw new Error(
          "BlueBubbles react requires messageId parameter (the message ID to react to). " +
            "Use action=react with messageId=<message_id>, emoji=<emoji>, and to/chatGuid to identify the chat.",
        );
      }
      // Resolve short ID (e.g., "1", "2") to full UUID
      const messageId = resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await resolveChatGuid();

      await sendBlueBubblesReaction({
        chatGuid: resolvedChatGuid,
        messageGuid: messageId,
        emoji,
        remove: remove || undefined,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        opts,
      });

      return jsonResult({ ok: true, ...(remove ? { removed: true } : { added: emoji }) });
    }

    // Handle edit action
    if (action === "edit") {
      // Edit is not supported on macOS 26+
      if (isMacOS26OrHigher(accountId ?? undefined)) {
        throw new Error(
          "BlueBubbles edit is not supported on macOS 26 or higher. " +
            "Apple removed the ability to edit iMessages in this version.",
        );
      }
      const rawMessageId = readStringParam(params, "messageId");
      const newText =
        readStringParam(params, "text") ??
        readStringParam(params, "newText") ??
        readStringParam(params, "message");
      if (!rawMessageId || !newText) {
        const missing: string[] = [];
        if (!rawMessageId) missing.push("messageId (the message ID to edit)");
        if (!newText) missing.push("text (the new message content)");
        throw new Error(
          `BlueBubbles edit requires: ${missing.join(", ")}. ` +
            `Use action=edit with messageId=<message_id>, text=<new_content>.`,
        );
      }
      // Resolve short ID (e.g., "1", "2") to full UUID
      const messageId = resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const backwardsCompatMessage = readStringParam(params, "backwardsCompatMessage");

      await editBlueBubblesMessage(messageId, newText, {
        ...opts,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        backwardsCompatMessage: backwardsCompatMessage ?? undefined,
      });

      return jsonResult({ ok: true, edited: rawMessageId });
    }

    // Handle unsend action
    if (action === "unsend") {
      const rawMessageId = readStringParam(params, "messageId");
      if (!rawMessageId) {
        throw new Error(
          "BlueBubbles unsend requires messageId parameter (the message ID to unsend). " +
            "Use action=unsend with messageId=<message_id>.",
        );
      }
      // Resolve short ID (e.g., "1", "2") to full UUID
      const messageId = resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });

      await unsendBlueBubblesMessage(messageId, {
        ...opts,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
      });

      return jsonResult({ ok: true, unsent: rawMessageId });
    }

    // Handle reply action
    if (action === "reply") {
      const rawMessageId = readStringParam(params, "messageId");
      const text = readMessageText(params);
      const to = readStringParam(params, "to") ?? readStringParam(params, "target");
      if (!rawMessageId || !text || !to) {
        const missing: string[] = [];
        if (!rawMessageId) missing.push("messageId (the message ID to reply to)");
        if (!text) missing.push("text or message (the reply message content)");
        if (!to) missing.push("to or target (the chat target)");
        throw new Error(
          `BlueBubbles reply requires: ${missing.join(", ")}. ` +
            `Use action=reply with messageId=<message_id>, message=<your reply>, target=<chat_target>.`,
        );
      }
      // Resolve short ID (e.g., "1", "2") to full UUID
      const messageId = resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });

      const result = await sendMessageBlueBubbles(to, text, {
        ...opts,
        replyToMessageGuid: messageId,
        replyToPartIndex: typeof partIndex === "number" ? partIndex : undefined,
      });

      return jsonResult({ ok: true, messageId: result.messageId, repliedTo: rawMessageId });
    }

    // Handle sendWithEffect action
    if (action === "sendWithEffect") {
      const text = readMessageText(params);
      const to = readStringParam(params, "to") ?? readStringParam(params, "target");
      const effectId = readStringParam(params, "effectId") ?? readStringParam(params, "effect");
      if (!text || !to || !effectId) {
        const missing: string[] = [];
        if (!text) missing.push("text or message (the message content)");
        if (!to) missing.push("to or target (the chat target)");
        if (!effectId)
          missing.push(
            "effectId or effect (e.g., slam, loud, gentle, invisible-ink, confetti, lasers, fireworks, balloons, heart)",
          );
        throw new Error(
          `BlueBubbles sendWithEffect requires: ${missing.join(", ")}. ` +
            `Use action=sendWithEffect with message=<message>, target=<chat_target>, effectId=<effect_name>.`,
        );
      }

      const result = await sendMessageBlueBubbles(to, text, {
        ...opts,
        effectId,
      });

      return jsonResult({ ok: true, messageId: result.messageId, effect: effectId });
    }

    // Handle renameGroup action
    if (action === "renameGroup") {
      const resolvedChatGuid = await resolveChatGuid();
      const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
      if (!displayName) {
        throw new Error("BlueBubbles renameGroup requires displayName or name parameter.");
      }

      await renameBlueBubblesChat(resolvedChatGuid, displayName, opts);

      return jsonResult({ ok: true, renamed: resolvedChatGuid, displayName });
    }

    // Handle setGroupIcon action
    if (action === "setGroupIcon") {
      const resolvedChatGuid = await resolveChatGuid();
      const base64Buffer = readStringParam(params, "buffer");
      const filename =
        readStringParam(params, "filename") ??
        readStringParam(params, "name") ??
        "icon.png";
      const contentType =
        readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");

      if (!base64Buffer) {
        throw new Error(
          "BlueBubbles setGroupIcon requires an image. " +
            "Use action=setGroupIcon with media=<image_url> or path=<local_file_path> to set the group icon.",
        );
      }

      // Decode base64 to buffer
      const buffer = Uint8Array.from(atob(base64Buffer), (c) => c.charCodeAt(0));

      await setGroupIconBlueBubbles(resolvedChatGuid, buffer, filename, {
        ...opts,
        contentType: contentType ?? undefined,
      });

      return jsonResult({ ok: true, chatGuid: resolvedChatGuid, iconSet: true });
    }

    // Handle addParticipant action
    if (action === "addParticipant") {
      const resolvedChatGuid = await resolveChatGuid();
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error("BlueBubbles addParticipant requires address or participant parameter.");
      }

      await addBlueBubblesParticipant(resolvedChatGuid, address, opts);

      return jsonResult({ ok: true, added: address, chatGuid: resolvedChatGuid });
    }

    // Handle removeParticipant action
    if (action === "removeParticipant") {
      const resolvedChatGuid = await resolveChatGuid();
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error("BlueBubbles removeParticipant requires address or participant parameter.");
      }

      await removeBlueBubblesParticipant(resolvedChatGuid, address, opts);

      return jsonResult({ ok: true, removed: address, chatGuid: resolvedChatGuid });
    }

    // Handle leaveGroup action
    if (action === "leaveGroup") {
      const resolvedChatGuid = await resolveChatGuid();

      await leaveBlueBubblesChat(resolvedChatGuid, opts);

      return jsonResult({ ok: true, left: resolvedChatGuid });
    }

    // Handle sendAttachment action
    if (action === "sendAttachment") {
      const to = readStringParam(params, "to", { required: true });
      const filename = readStringParam(params, "filename", { required: true });
      const caption = readStringParam(params, "caption");
      const contentType =
        readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");

      // Buffer can come from params.buffer (base64) or params.path (file path)
      const base64Buffer = readStringParam(params, "buffer");
      const filePath = readStringParam(params, "path") ?? readStringParam(params, "filePath");

      let buffer: Uint8Array;
      if (base64Buffer) {
        // Decode base64 to buffer
        buffer = Uint8Array.from(atob(base64Buffer), (c) => c.charCodeAt(0));
      } else if (filePath) {
        // Read file from path (will be handled by caller providing buffer)
        throw new Error(
          "BlueBubbles sendAttachment: filePath not supported in action, provide buffer as base64.",
        );
      } else {
        throw new Error("BlueBubbles sendAttachment requires buffer (base64) parameter.");
      }

      const result = await sendBlueBubblesAttachment({
        to,
        buffer,
        filename,
        contentType: contentType ?? undefined,
        caption: caption ?? undefined,
        opts,
      });

      return jsonResult({ ok: true, messageId: result.messageId });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
