import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { resolveIMessageAccount } from "./accounts.js";
import { IMESSAGE_ACTION_NAMES, IMESSAGE_ACTIONS } from "./actions-contract.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";
import { describeIMessageMessageTool } from "./message-tool-api.js";
import { findLatestIMessageEntryForChat, type IMessageChatContext } from "./monitor-reply-cache.js";
import { getCachedIMessagePrivateApiStatus } from "./probe.js";
import { parseIMessageTarget, type IMessageTarget } from "./targets.js";

const loadIMessageActionsRuntime = createLazyRuntimeNamedExport(
  () => import("./actions.runtime.js"),
  "imessageActionsRuntime",
);

const providerId = "imessage";

const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>([
  ...IMESSAGE_ACTION_NAMES,
  "upload-file",
]);
function readMessageText(params: Record<string, unknown>): string | undefined {
  return readStringParam(params, "text") ?? readStringParam(params, "message");
}

/**
 * Read messageId from the action params, falling back to the most recent
 * inbound in the same chat when the caller omitted it. The natural intent
 * for "react with 👍" or "tapback the last message" is the message that
 * just arrived in the current conversation; making the agent re-quote a
 * message id every time is friction the cache already has the answer for.
 */
function readMessageIdWithChatFallback(
  params: Record<string, unknown>,
  chatContext: IMessageChatContext & { accountId: string },
): string {
  const explicit = readStringParam(params, "messageId");
  if (explicit) {
    return explicit;
  }
  const latest = findLatestIMessageEntryForChat(chatContext);
  if (latest?.messageId) {
    return latest.messageId;
  }
  // Surface the same error the strict readMessageId would have, so the
  // agent gets a clear "you must supply messageId" signal when there is
  // also no cached message to fall back to.
  return readStringParam(params, "messageId", { required: true });
}

type IMessageActionsRuntime = Awaited<ReturnType<typeof loadIMessageActionsRuntime>>;

async function resolveChatGuid(params: {
  action: ChannelMessageActionName;
  actionParams: Record<string, unknown>;
  currentChannelId?: string;
  runtime: IMessageActionsRuntime;
  options: {
    cliPath: string;
    dbPath?: string;
    timeoutMs?: number;
  };
}): Promise<string> {
  const explicitChatGuid = readStringParam(params.actionParams, "chatGuid");
  if (explicitChatGuid) {
    return explicitChatGuid;
  }
  const explicitChatId = readNumberParam(params.actionParams, "chatId", { integer: true });
  if (typeof explicitChatId === "number") {
    const resolved = await params.runtime.resolveChatGuidForTarget({
      target: { kind: "chat_id", chatId: explicitChatId },
      options: params.options,
    });
    if (resolved) {
      return resolved;
    }
    throw new Error(`iMessage ${params.action} failed: chatGuid not found for chat_id:<redacted>.`);
  }
  const explicitChatIdentifier = readStringParam(params.actionParams, "chatIdentifier");
  if (explicitChatIdentifier) {
    const resolved = await params.runtime.resolveChatGuidForTarget({
      target: { kind: "chat_identifier", chatIdentifier: explicitChatIdentifier },
      options: params.options,
    });
    if (resolved) {
      return resolved;
    }
    throw new Error(
      `iMessage ${params.action} failed: chatGuid not found for chat_identifier:<redacted>.`,
    );
  }
  const rawTarget =
    readStringParam(params.actionParams, "to") ??
    readStringParam(params.actionParams, "target") ??
    (params.currentChannelId?.trim() || undefined);
  if (rawTarget) {
    const target = parseIMessageTarget(rawTarget);
    if (target.kind === "chat_guid") {
      return target.chatGuid;
    }
    if (target.kind === "chat_id" || target.kind === "chat_identifier") {
      const resolved = await params.runtime.resolveChatGuidForTarget({
        target,
        options: params.options,
      });
      if (resolved) {
        return resolved;
      }
      throw new Error(
        `iMessage ${params.action} failed: chatGuid not found for ${formatUnresolvedTarget(target)}.`,
      );
    }
    if (target.kind === "handle") {
      // A bare phone/email is a valid chat scope for direct messages —
      // Messages addresses DMs as `iMessage;-;<handle>` / `SMS;-;<handle>`.
      // Promote it to chat_identifier so resolveChatGuidForTarget (which
      // only accepts chat_id / chat_identifier kinds) can look it up.
      const synthesizedIdentifier = `${target.service === "sms" ? "SMS" : "iMessage"};-;${target.to}`;
      const resolved = await params.runtime.resolveChatGuidForTarget({
        target: { kind: "chat_identifier", chatIdentifier: synthesizedIdentifier },
        options: params.options,
      });
      if (resolved) {
        return resolved;
      }
      // Per-action fallback policy:
      //  - send / reply / sendWithEffect / sendAttachment: fine to send to
      //    a synthesized DM identifier; Messages will register the chat.
      //  - react / edit / unsend: these mutate an existing message that
      //    must already exist in the chat. If we have no registered chat
      //    we have no message to act on, and synthesizing the identifier
      //    just produces a confusing CLI failure.
      if (params.action === "react" || params.action === "edit" || params.action === "unsend") {
        throw new Error(
          `iMessage ${params.action} requires a known chat. ` +
            `No registered chat for the supplied target; send a message first or pass an explicit chatGuid.`,
        );
      }
      return synthesizedIdentifier;
    }
  }
  throw new Error(
    `iMessage ${params.action} requires chatGuid, chatId, chatIdentifier, or a chat target.`,
  );
}

function formatUnresolvedTarget(
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>,
): string {
  // Redact the actual identifier — error strings end up in agent tool
  // results and log streams, and exposing a chat_id or chat_identifier
  // there would leak the conversation handle to anything that observes
  // them.
  return target.kind === "chat_id" ? "chat_id:<redacted>" : "chat_identifier:<redacted>";
}

function buildChatContextFromActionParams(params: {
  actionParams: Record<string, unknown>;
  currentChannelId?: string;
}): IMessageChatContext {
  const explicitChatGuid = readStringParam(params.actionParams, "chatGuid")?.trim();
  const explicitChatIdentifier = readStringParam(params.actionParams, "chatIdentifier")?.trim();
  const explicitChatId = readNumberParam(params.actionParams, "chatId", { integer: true });
  // Trim before the truthy check so a whitespace-only currentChannelId can't
  // reach parseIMessageTarget (which throws on empty/whitespace input and
  // would abort the whole action with a confusing "target is required").
  const rawTarget =
    readStringParam(params.actionParams, "to") ??
    readStringParam(params.actionParams, "target") ??
    (params.currentChannelId?.trim() || undefined);
  const target = rawTarget ? parseIMessageTarget(rawTarget) : null;
  // A "handle" target (raw phone or email — what the agent uses most of the
  // time) is still a usable chat scope: Messages addresses DMs as
  // `iMessage;-;+15551234567` / `SMS;-;+15551234567`. Synthesizing the
  // chat-identifier here lets resolveIMessageMessageId succeed without
  // forcing every action plumbing site to also surface chatGuid/chatId.
  const handleChatIdentifier =
    target?.kind === "handle"
      ? `${target.service === "sms" ? "SMS" : "iMessage"};-;${target.to}`
      : undefined;
  return {
    chatGuid: explicitChatGuid || (target?.kind === "chat_guid" ? target.chatGuid : undefined),
    chatIdentifier:
      explicitChatIdentifier ||
      (target?.kind === "chat_identifier" ? target.chatIdentifier : undefined) ||
      handleChatIdentifier,
    chatId:
      typeof explicitChatId === "number"
        ? explicitChatId
        : target?.kind === "chat_id"
          ? target.chatId
          : undefined,
  };
}

function mapTapbackReaction(emoji?: string): string | undefined {
  const value = normalizeOptionalLowercaseString(emoji)?.replace(/\ufe0f/g, "");
  if (!value) {
    return undefined;
  }
  if (["love", "heart", "❤", "❤️"].includes(value)) {
    return "love";
  }
  if (["like", "+1", "thumbsup", "👍"].includes(value)) {
    return "like";
  }
  if (["dislike", "-1", "thumbsdown", "👎"].includes(value)) {
    return "dislike";
  }
  if (["laugh", "haha", "😂", "🤣"].includes(value)) {
    return "laugh";
  }
  if (["emphasize", "!!", "‼", "‼️"].includes(value)) {
    return "emphasize";
  }
  if (["question", "?", "？", "❓"].includes(value)) {
    return "question";
  }
  return undefined;
}

function decodeBase64Buffer(params: Record<string, unknown>, action: string): Uint8Array {
  const base64Buffer = readStringParam(params, "buffer");
  if (!base64Buffer) {
    throw new Error(`iMessage ${action} requires buffer (base64) parameter.`);
  }
  return Uint8Array.from(Buffer.from(base64Buffer, "base64"));
}

// Path-shaped attachment params the message-tool schema declares. We only
// look at these to detect an unhydrated bypass attempt — the resolver in
// hydrateAttachmentParamsForAction is responsible for loading them into
// `buffer`/`filename` after enforcing localRoots, sandbox, and size limits.
const REPLY_ATTACHMENT_PATH_PARAM_NAMES: readonly string[] = [
  "filePath",
  "path",
  "media",
  "mediaUrl",
  "fileUrl",
] as const;

type ReplyAttachmentSpec = { kind: "buffer"; buffer: Uint8Array; filename: string };

// Reply attachments must arrive hydrated: the core message-action runner
// loads `path`/`media`/`mediaUrl`/`filePath`/`fileUrl` through the outbound
// media resolver (mediaLocalRoots / sandbox / size limits / SSRF) and writes
// the result into `buffer` + `filename`. We deliberately do not consume raw
// path params here — accepting them would let an agent send any host file
// imsg can read, bypassing the resolver. If a path-shaped param is present
// without a corresponding `buffer`, the caller skipped hydration (most
// likely calling handleAction directly in a test); fail loudly instead.
function extractReplyAttachment(
  params: Record<string, unknown>,
): { spec: ReplyAttachmentSpec; sourceParam: string } | { spec: null; bypassParam: string } | null {
  const buffer = readStringParam(params, "buffer");
  if (buffer) {
    const filename = readStringParam(params, "filename") ?? "attachment.bin";
    return {
      spec: {
        kind: "buffer",
        buffer: Uint8Array.from(Buffer.from(buffer, "base64")),
        filename,
      },
      sourceParam: "buffer",
    };
  }
  for (const name of REPLY_ATTACHMENT_PATH_PARAM_NAMES) {
    if (readStringParam(params, name)) {
      return { spec: null, bypassParam: name };
    }
  }
  return null;
}

// Whitelist of expressive-send effect IDs the bridge accepts. Restricting
// to a fixed set lets us return a clear error for typos ("invisible_ink"
// vs "invisibleink") instead of silently forwarding gibberish to the
// bridge and surfacing an opaque CLI failure.
const KNOWN_EFFECT_IDS: ReadonlySet<string> = new Set([
  "com.apple.MobileSMS.expressivesend.impact",
  "com.apple.MobileSMS.expressivesend.loud",
  "com.apple.MobileSMS.expressivesend.gentle",
  "com.apple.MobileSMS.expressivesend.invisibleink",
  "com.apple.MobileSMS.expressivesend.confetti",
  "com.apple.MobileSMS.expressivesend.lasers",
  "com.apple.MobileSMS.expressivesend.fireworks",
  "com.apple.MobileSMS.expressivesend.balloon",
  "com.apple.MobileSMS.expressivesend.heart",
  "com.apple.messages.effect.CKEchoEffect",
  "com.apple.messages.effect.CKHappyBirthdayEffect",
  "com.apple.messages.effect.CKShootingStarEffect",
  "com.apple.messages.effect.CKSparklesEffect",
  "com.apple.messages.effect.CKSpotlightEffect",
]);

function effectIdFromParam(raw?: string): string | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (!value) {
    return undefined;
  }
  const aliases: Record<string, string> = {
    slam: "com.apple.MobileSMS.expressivesend.impact",
    impact: "com.apple.MobileSMS.expressivesend.impact",
    loud: "com.apple.MobileSMS.expressivesend.loud",
    gentle: "com.apple.MobileSMS.expressivesend.gentle",
    "invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
    invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
    confetti: "com.apple.MobileSMS.expressivesend.confetti",
    lasers: "com.apple.MobileSMS.expressivesend.lasers",
    fireworks: "com.apple.MobileSMS.expressivesend.fireworks",
    balloons: "com.apple.MobileSMS.expressivesend.balloon",
    balloon: "com.apple.MobileSMS.expressivesend.balloon",
    heart: "com.apple.MobileSMS.expressivesend.heart",
    // Background screen effects (com.apple.messages.effect.CK*Effect).
    // The error message below advertises these short names, so they must
    // map to the canonical CKEffect identifier — without this, agents
    // that follow our own guidance get "unknown effect" thrown back.
    echo: "com.apple.messages.effect.CKEchoEffect",
    happybirthday: "com.apple.messages.effect.CKHappyBirthdayEffect",
    "happy-birthday": "com.apple.messages.effect.CKHappyBirthdayEffect",
    shootingstar: "com.apple.messages.effect.CKShootingStarEffect",
    "shooting-star": "com.apple.messages.effect.CKShootingStarEffect",
    sparkles: "com.apple.messages.effect.CKSparklesEffect",
    spotlight: "com.apple.messages.effect.CKSpotlightEffect",
  };
  const resolved = aliases[value] ?? raw;
  if (typeof resolved === "string" && KNOWN_EFFECT_IDS.has(resolved)) {
    return resolved;
  }
  throw new Error(
    `iMessage sendWithEffect rejected unknown effect "${raw}". ` +
      "Use one of: slam, loud, gentle, invisibleink, confetti, lasers, fireworks, balloon, heart, " +
      "echo, happybirthday, shootingstar, sparkles, spotlight (or the canonical com.apple.MobileSMS.expressivesend.* / com.apple.messages.effect.* identifier).",
  );
}

function assertActionEnabled(
  action: ChannelMessageActionName,
  actionsConfig: Record<string, boolean | undefined> | undefined,
): void {
  const canonicalAction = action === "upload-file" ? "sendAttachment" : action;
  const spec = IMESSAGE_ACTIONS[canonicalAction as keyof typeof IMESSAGE_ACTIONS];
  if (!spec?.gate || !createActionGate(actionsConfig)(spec.gate)) {
    throw new Error(`iMessage ${action} is disabled in config.`);
  }
}

export const imessageMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeIMessageMessageTool,
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  messageActionTargetAliases: {
    react: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
    edit: { aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"] },
    unsend: { aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"] },
    reply: { aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"] },
    sendWithEffect: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
    sendAttachment: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
    "upload-file": { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
    renameGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
    setGroupIcon: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
    addParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
    removeParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
    leaveGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  },
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    const runtime = await loadIMessageActionsRuntime();
    const account = resolveIMessageAccount({
      cfg,
      accountId: accountId ?? undefined,
    });
    assertActionEnabled(action, account.config.actions);
    const cliPathForProbe = account.config.cliPath?.trim() || "imsg";
    let privateApiStatus = getCachedIMessagePrivateApiStatus(cliPathForProbe);
    const assertPrivateApiEnabled = async () => {
      if (privateApiStatus?.available !== true) {
        // Probe lazily: the running gateway only populates the cache via the
        // status adapter, which doesn't fire eagerly on first dispatch. Run
        // an inline probe so the first react/send-rich attempt after `imsg
        // launch` succeeds without requiring a manual `channels status`.
        const { probeIMessagePrivateApi } = await import("./probe.js");
        privateApiStatus = await probeIMessagePrivateApi(
          cliPathForProbe,
          account.config.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS,
        );
      }
      if (!privateApiStatus?.available) {
        throw new Error(
          `iMessage ${action} requires the imsg private API bridge. Run imsg launch, then openclaw channels status to refresh capability detection.`,
        );
      }
    };
    const opts = {
      cliPath: account.config.cliPath?.trim() || "imsg",
      dbPath: account.config.dbPath?.trim() || undefined,
      timeoutMs: account.config.probeTimeoutMs,
      chatGuid: "",
    };
    const chatGuid = async () =>
      await resolveChatGuid({
        action,
        actionParams: params,
        currentChannelId: toolContext?.currentChannelId,
        runtime,
        options: opts,
      });
    const messageId = (resolveOpts?: { requireFromMe?: boolean }) => {
      const chatContext = buildChatContextFromActionParams({
        actionParams: params,
        currentChannelId: toolContext?.currentChannelId,
      });
      const fallbackContext = { ...chatContext, accountId: account.accountId };
      return runtime.resolveIMessageMessageId(
        readMessageIdWithChatFallback(params, fallbackContext),
        {
          requireKnownShortId: true,
          chatContext,
          ...(resolveOpts?.requireFromMe ? { requireFromMe: true } : {}),
        },
      );
    };

    if (action === "react") {
      await assertPrivateApiEnabled();
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove an iMessage reaction.",
      });
      const reaction = mapTapbackReaction(emoji);
      const TAPBACK_KINDS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
      // For add operations we need a recognized tapback kind. For remove
      // operations, the agent may not remember which kind it added — when
      // the emoji is empty or unrecognized but `remove: true`, fan out a
      // remove against every known kind. The bridge no-ops kinds that
      // weren't there, so this is safe and matches user intent ("undo my
      // reaction, whatever it was").
      if (!remove && (isEmpty || !reaction)) {
        throw new Error(
          "iMessage react supports love, like, dislike, laugh, emphasize, and question tapbacks.",
        );
      }
      const resolvedMessageId = messageId();
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await chatGuid();
      const reactionsToSend = remove && !reaction ? [...TAPBACK_KINDS] : reaction ? [reaction] : [];
      for (const kind of reactionsToSend) {
        await runtime.sendReaction({
          chatGuid: resolvedChatGuid,
          messageId: resolvedMessageId,
          reaction: kind,
          remove: remove || undefined,
          partIndex: typeof partIndex === "number" ? partIndex : undefined,
          options: { ...opts, chatGuid: resolvedChatGuid },
        });
      }
      return jsonResult({ ok: true, ...(remove ? { removed: true } : { added: reaction }) });
    }

    if (action === "edit") {
      await assertPrivateApiEnabled();
      const resolvedMessageId = messageId({ requireFromMe: true });
      const text =
        readStringParam(params, "text") ??
        readStringParam(params, "newText") ??
        readStringParam(params, "message");
      if (!text) {
        throw new Error("iMessage edit requires text, newText, or message.");
      }
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const backwardsCompatMessage = readStringParam(params, "backwardsCompatMessage");
      const resolvedChatGuid = await chatGuid();
      await runtime.editMessage({
        chatGuid: resolvedChatGuid,
        messageId: resolvedMessageId,
        text,
        backwardsCompatMessage: backwardsCompatMessage ?? undefined,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, edited: resolvedMessageId });
    }

    if (action === "unsend") {
      await assertPrivateApiEnabled();
      const resolvedMessageId = messageId({ requireFromMe: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await chatGuid();
      await runtime.unsendMessage({
        chatGuid: resolvedChatGuid,
        messageId: resolvedMessageId,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, unsent: resolvedMessageId });
    }

    if (action === "reply") {
      await assertPrivateApiEnabled();
      const resolvedMessageId = messageId();
      const text = readMessageText(params);
      if (!text) {
        throw new Error("iMessage reply requires text or message.");
      }
      const attachment = extractReplyAttachment(params);
      if (attachment) {
        if (attachment.spec === null) {
          throw new Error(
            `iMessage reply rejected \`${attachment.bypassParam}\` because it did not pass through the outbound media resolver. ` +
              'Pass a base64 `buffer` + `filename` directly, or invoke message(action: "reply") through the runner so the resolver ' +
              "can validate the path against mediaLocalRoots/sandbox/size before sending.",
          );
        }
        // Reply-with-attachment requires the `imsg send-rich --file` flag
        // (openclaw/imsg#114). Older imsg builds reject the option, so
        // refuse loudly here rather than letting send-rich ship the text
        // alone and silently drop the attachment — the original symptom
        // of openclaw/openclaw#79822.
        if (privateApiStatus?.cliCapabilities?.sendRichSupportsAttachment !== true) {
          throw new Error(
            "iMessage reply with an attachment needs an imsg build that exposes `send-rich --file` " +
              "(openclaw/imsg#114). Upgrade imsg, or use action 'upload-file' (with filePath/filename) " +
              "or action 'send' (with media) to deliver the file plus a separate 'reply' for any text.",
          );
        }
      }
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendRichMessage({
        chatGuid: resolvedChatGuid,
        text,
        replyToMessageId: resolvedMessageId,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        attachment: attachment?.spec ?? undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, messageId: result.messageId, repliedTo: resolvedMessageId });
    }

    if (action === "sendWithEffect") {
      await assertPrivateApiEnabled();
      const text = readMessageText(params);
      const effectId = effectIdFromParam(
        readStringParam(params, "effectId") ?? readStringParam(params, "effect"),
      );
      if (!text || !effectId) {
        throw new Error("iMessage sendWithEffect requires text/message and effect/effectId.");
      }
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendRichMessage({
        chatGuid: resolvedChatGuid,
        text,
        effectId,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, messageId: result.messageId, effect: effectId });
    }

    if (action === "renameGroup") {
      await assertPrivateApiEnabled();
      const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
      if (!displayName) {
        throw new Error("iMessage renameGroup requires displayName or name.");
      }
      const resolvedChatGuid = await chatGuid();
      await runtime.renameGroup({
        chatGuid: resolvedChatGuid,
        displayName,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, renamed: resolvedChatGuid, displayName });
    }

    if (action === "setGroupIcon") {
      await assertPrivateApiEnabled();
      const filename =
        readStringParam(params, "filename") ?? readStringParam(params, "name") ?? "icon.png";
      const resolvedChatGuid = await chatGuid();
      await runtime.setGroupIcon({
        chatGuid: resolvedChatGuid,
        buffer: decodeBase64Buffer(params, action),
        filename,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, chatGuid: resolvedChatGuid, iconSet: true });
    }

    if (action === "addParticipant" || action === "removeParticipant") {
      await assertPrivateApiEnabled();
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error(`iMessage ${action} requires address or participant.`);
      }
      const resolvedChatGuid = await chatGuid();
      if (action === "addParticipant") {
        await runtime.addParticipant({
          chatGuid: resolvedChatGuid,
          address,
          options: { ...opts, chatGuid: resolvedChatGuid },
        });
        return jsonResult({ ok: true, added: address, chatGuid: resolvedChatGuid });
      }
      await runtime.removeParticipant({
        chatGuid: resolvedChatGuid,
        address,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, removed: address, chatGuid: resolvedChatGuid });
    }

    if (action === "leaveGroup") {
      await assertPrivateApiEnabled();
      const resolvedChatGuid = await chatGuid();
      await runtime.leaveGroup({
        chatGuid: resolvedChatGuid,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, left: resolvedChatGuid });
    }

    if (action === "sendAttachment" || action === "upload-file") {
      await assertPrivateApiEnabled();
      const filename = readStringParam(params, "filename", { required: true });
      const asVoice = readBooleanParam(params, "asVoice") ?? readBooleanParam(params, "as_voice");
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendAttachment({
        chatGuid: resolvedChatGuid,
        buffer: decodeBase64Buffer(params, action),
        filename,
        asVoice: asVoice ?? undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, messageId: result.messageId });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
