import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { resolveBlueBubblesAccount } from "./accounts.js";
import {
  BLUEBUBBLES_ACTION_NAMES,
  BLUEBUBBLES_ACTIONS,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionName,
} from "./actions-api.js";
import type { BlueBubblesChatContext } from "./monitor-reply-cache.js";
import { getCachedBlueBubblesPrivateApiStatus, isMacOS26OrHigher } from "./probe.js";
import { normalizeSecretInputString } from "./secret-input.js";
import {
  buildBlueBubblesChatContextFromTarget,
  normalizeBlueBubblesHandle,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesTarget,
} from "./targets.js";
import type { BlueBubblesSendTarget } from "./types.js";

const loadBlueBubblesActionsRuntime = createLazyRuntimeNamedExport(
  () => import("./actions.runtime.js"),
  "blueBubblesActionsRuntime",
);

const providerId = "bluebubbles";

function mapTarget(raw: string): BlueBubblesSendTarget {
  const parsed = parseBlueBubblesTarget(raw);
  if (parsed.kind === "chat_guid") {
    return { kind: "chat_guid", chatGuid: parsed.chatGuid };
  }
  if (parsed.kind === "chat_id") {
    return { kind: "chat_id", chatId: parsed.chatId };
  }
  if (parsed.kind === "chat_identifier") {
    return { kind: "chat_identifier", chatIdentifier: parsed.chatIdentifier };
  }
  return {
    kind: "handle",
    address: normalizeBlueBubblesHandle(parsed.to),
    service: parsed.service,
  };
}

/**
 * Collect any chat-identifying hints the action caller supplied, so short
 * message id resolution can reject cross-chat collisions. The order of
 * precedence mirrors resolveChatGuid: explicit chat* params first, then the
 * `to`/`target` param, then the current session channel as a last resort.
 */
function buildChatContextFromActionParams(params: {
  actionParams: Record<string, unknown>;
  currentChannelId?: string;
}): BlueBubblesChatContext {
  const explicitChatGuid = readStringParam(params.actionParams, "chatGuid")?.trim();
  const explicitChatIdentifier = readStringParam(params.actionParams, "chatIdentifier")?.trim();
  const explicitChatId = readNumberParam(params.actionParams, "chatId", { integer: true });
  const rawTarget =
    readStringParam(params.actionParams, "to") ??
    readStringParam(params.actionParams, "target") ??
    params.currentChannelId ??
    undefined;
  const targetContext = buildBlueBubblesChatContextFromTarget(rawTarget);
  return {
    chatGuid: explicitChatGuid || targetContext.chatGuid,
    chatIdentifier: explicitChatIdentifier || targetContext.chatIdentifier,
    chatId: typeof explicitChatId === "number" ? explicitChatId : targetContext.chatId,
  };
}

function readMessageText(params: Record<string, unknown>): string | undefined {
  return readStringParam(params, "text") ?? readStringParam(params, "message");
}

/** Supported action names for BlueBubbles */
const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>([
  ...BLUEBUBBLES_ACTION_NAMES,
  "upload-file",
]);
const PRIVATE_API_ACTIONS = new Set<ChannelMessageActionName>([
  "react",
  "edit",
  "unsend",
  "reply",
  "sendWithEffect",
  "renameGroup",
  "setGroupIcon",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
]);

export const bluebubblesMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId, currentChannelId }) => {
    const account = resolveBlueBubblesAccount({ cfg, accountId });
    if (!account.enabled || !account.configured) {
      return null;
    }
    const gate = createActionGate(account.config.actions);
    const actions = new Set<ChannelMessageActionName>();
    const macOS26 = isMacOS26OrHigher(account.accountId);
    const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(account.accountId);
    for (const action of BLUEBUBBLES_ACTION_NAMES) {
      const spec = BLUEBUBBLES_ACTIONS[action];
      if (!spec?.gate) {
        continue;
      }
      if (privateApiStatus === false && PRIVATE_API_ACTIONS.has(action)) {
        continue;
      }
      if ("unsupportedOnMacOS26" in spec && spec.unsupportedOnMacOS26 && macOS26) {
        continue;
      }
      if (gate(spec.gate)) {
        actions.add(action);
      }
    }
    const normalizedTarget = currentChannelId
      ? normalizeBlueBubblesMessagingTarget(currentChannelId)
      : undefined;
    const lowered = normalizeOptionalLowercaseString(normalizedTarget) ?? "";
    const isGroupTarget =
      lowered.startsWith("chat_guid:") ||
      lowered.startsWith("chat_id:") ||
      lowered.startsWith("chat_identifier:") ||
      lowered.startsWith("group:");
    if (!isGroupTarget) {
      for (const action of BLUEBUBBLES_ACTION_NAMES) {
        if ("groupOnly" in BLUEBUBBLES_ACTIONS[action] && BLUEBUBBLES_ACTIONS[action].groupOnly) {
          actions.delete(action);
        }
      }
    }
    if (actions.delete("sendAttachment")) {
      actions.add("upload-file");
    }
    return { actions: Array.from(actions) };
  },
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    const runtime = await loadBlueBubblesActionsRuntime();
    const account = resolveBlueBubblesAccount({
      cfg: cfg,
      accountId: accountId ?? undefined,
    });
    const baseUrl = normalizeSecretInputString(account.config.serverUrl);
    const password = normalizeSecretInputString(account.config.password);
    const opts = { cfg: cfg, accountId: accountId ?? undefined };
    const assertPrivateApiEnabled = () => {
      if (getCachedBlueBubblesPrivateApiStatus(account.accountId) === false) {
        throw new Error(
          `BlueBubbles ${action} requires Private API, but it is disabled on the BlueBubbles server.`,
        );
      }
    };

    // Helper to resolve chatGuid from various params or session context
    const resolveChatGuid = async (): Promise<string> => {
      const chatGuid = readStringParam(params, "chatGuid");
      if (chatGuid?.trim()) {
        return chatGuid.trim();
      }

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

      const resolved = await runtime.resolveChatGuidForTarget({
        baseUrl,
        password,
        target,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
      });
      if (!resolved) {
        throw new Error(`BlueBubbles ${action} failed: chatGuid not found for target.`);
      }
      return resolved;
    };

    // Handle react action
    if (action === "react") {
      assertPrivateApiEnabled();
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
      // Resolve short ID (e.g., "1", "2") to full UUID, scoped to the chat the
      // caller is acting on so a short ID from a different chat cannot be
      // silently accepted (see cross-chat guard in resolveBlueBubblesMessageId).
      const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, {
        requireKnownShortId: true,
        chatContext: buildChatContextFromActionParams({
          actionParams: params,
          currentChannelId: toolContext?.currentChannelId,
        }),
      });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await resolveChatGuid();

      await runtime.sendBlueBubblesReaction({
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
      assertPrivateApiEnabled();
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
        if (!rawMessageId) {
          missing.push("messageId (the message ID to edit)");
        }
        if (!newText) {
          missing.push("text (the new message content)");
        }
        throw new Error(
          `BlueBubbles edit requires: ${missing.join(", ")}. ` +
            `Use action=edit with messageId=<message_id>, text=<new_content>.`,
        );
      }
      // Resolve short ID (e.g., "1", "2") to full UUID, scoped to the chat
      // the caller is acting on (cross-chat guard).
      const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, {
        requireKnownShortId: true,
        chatContext: buildChatContextFromActionParams({
          actionParams: params,
          currentChannelId: toolContext?.currentChannelId,
        }),
      });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const backwardsCompatMessage = readStringParam(params, "backwardsCompatMessage");

      await runtime.editBlueBubblesMessage(messageId, newText, {
        ...opts,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        backwardsCompatMessage: backwardsCompatMessage ?? undefined,
      });

      return jsonResult({ ok: true, edited: rawMessageId });
    }

    // Handle unsend action
    if (action === "unsend") {
      assertPrivateApiEnabled();
      const rawMessageId = readStringParam(params, "messageId");
      if (!rawMessageId) {
        throw new Error(
          "BlueBubbles unsend requires messageId parameter (the message ID to unsend). " +
            "Use action=unsend with messageId=<message_id>.",
        );
      }
      // Resolve short ID (e.g., "1", "2") to full UUID, scoped to the chat
      // the caller is acting on (cross-chat guard).
      const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, {
        requireKnownShortId: true,
        chatContext: buildChatContextFromActionParams({
          actionParams: params,
          currentChannelId: toolContext?.currentChannelId,
        }),
      });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });

      await runtime.unsendBlueBubblesMessage(messageId, {
        ...opts,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
      });

      return jsonResult({ ok: true, unsent: rawMessageId });
    }

    // Handle reply action
    if (action === "reply") {
      assertPrivateApiEnabled();
      const rawMessageId = readStringParam(params, "messageId");
      const text = readMessageText(params);
      const to = readStringParam(params, "to") ?? readStringParam(params, "target");
      if (!rawMessageId || !text || !to) {
        const missing: string[] = [];
        if (!rawMessageId) {
          missing.push("messageId (the message ID to reply to)");
        }
        if (!text) {
          missing.push("text or message (the reply message content)");
        }
        if (!to) {
          missing.push("to or target (the chat target)");
        }
        throw new Error(
          `BlueBubbles reply requires: ${missing.join(", ")}. ` +
            `Use action=reply with messageId=<message_id>, message=<your reply>, target=<chat_target>.`,
        );
      }
      // Resolve short ID (e.g., "1", "2") to full UUID, scoped to the chat
      // the caller is acting on (cross-chat guard).
      const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, {
        requireKnownShortId: true,
        chatContext: buildChatContextFromActionParams({
          actionParams: params,
          currentChannelId: toolContext?.currentChannelId,
        }),
      });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });

      const result = await runtime.sendMessageBlueBubbles(to, text, {
        ...opts,
        replyToMessageGuid: messageId,
        replyToPartIndex: typeof partIndex === "number" ? partIndex : undefined,
      });

      return jsonResult({ ok: true, messageId: result.messageId, repliedTo: rawMessageId });
    }

    // Handle sendWithEffect action
    if (action === "sendWithEffect") {
      assertPrivateApiEnabled();
      const text = readMessageText(params);
      const to = readStringParam(params, "to") ?? readStringParam(params, "target");
      const effectId = readStringParam(params, "effectId") ?? readStringParam(params, "effect");
      if (!text || !to || !effectId) {
        const missing: string[] = [];
        if (!text) {
          missing.push("text or message (the message content)");
        }
        if (!to) {
          missing.push("to or target (the chat target)");
        }
        if (!effectId) {
          missing.push(
            "effectId or effect (e.g., slam, loud, gentle, invisible-ink, confetti, lasers, fireworks, balloons, heart)",
          );
        }
        throw new Error(
          `BlueBubbles sendWithEffect requires: ${missing.join(", ")}. ` +
            `Use action=sendWithEffect with message=<message>, target=<chat_target>, effectId=<effect_name>.`,
        );
      }

      const result = await runtime.sendMessageBlueBubbles(to, text, {
        ...opts,
        effectId,
      });

      return jsonResult({ ok: true, messageId: result.messageId, effect: effectId });
    }

    // Handle renameGroup action
    if (action === "renameGroup") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
      if (!displayName) {
        throw new Error("BlueBubbles renameGroup requires displayName or name parameter.");
      }

      await runtime.renameBlueBubblesChat(resolvedChatGuid, displayName, opts);

      return jsonResult({ ok: true, renamed: resolvedChatGuid, displayName });
    }

    // Handle setGroupIcon action
    if (action === "setGroupIcon") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      const base64Buffer = readStringParam(params, "buffer");
      const filename =
        readStringParam(params, "filename") ?? readStringParam(params, "name") ?? "icon.png";
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

      await runtime.setGroupIconBlueBubbles(resolvedChatGuid, buffer, filename, {
        ...opts,
        contentType: contentType ?? undefined,
      });

      return jsonResult({ ok: true, chatGuid: resolvedChatGuid, iconSet: true });
    }

    // Handle addParticipant action
    if (action === "addParticipant") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error("BlueBubbles addParticipant requires address or participant parameter.");
      }

      await runtime.addBlueBubblesParticipant(resolvedChatGuid, address, opts);

      return jsonResult({ ok: true, added: address, chatGuid: resolvedChatGuid });
    }

    // Handle removeParticipant action
    if (action === "removeParticipant") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error("BlueBubbles removeParticipant requires address or participant parameter.");
      }

      await runtime.removeBlueBubblesParticipant(resolvedChatGuid, address, opts);

      return jsonResult({ ok: true, removed: address, chatGuid: resolvedChatGuid });
    }

    // Handle leaveGroup action
    if (action === "leaveGroup") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();

      await runtime.leaveBlueBubblesChat(resolvedChatGuid, opts);

      return jsonResult({ ok: true, left: resolvedChatGuid });
    }

    // Handle sendAttachment action (legacy) and upload-file (canonical)
    if (action === "sendAttachment" || action === "upload-file") {
      const to = readStringParam(params, "to", { required: true });
      const filename = readStringParam(params, "filename", { required: true });
      const caption = readStringParam(params, "caption") ?? readStringParam(params, "message");
      const contentType =
        readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
      const asVoice = readBooleanParam(params, "asVoice");

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
          `BlueBubbles ${action}: filePath not supported in action, provide buffer as base64.`,
        );
      } else {
        throw new Error(`BlueBubbles ${action} requires buffer (base64) parameter.`);
      }

      const result = await runtime.sendBlueBubblesAttachment({
        to,
        buffer,
        filename,
        contentType: contentType ?? undefined,
        caption: caption ?? undefined,
        asVoice: asVoice ?? undefined,
        opts,
      });

      return jsonResult({ ok: true, messageId: result.messageId });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
