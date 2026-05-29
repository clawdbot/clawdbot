import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedSlackAccount } from "./accounts.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { resolveSlackChannelConfig } from "./monitor/channel-config.js";
import { isSlackChannelAllowedByPolicy } from "./monitor/policy.js";
import {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readPositiveIntegerParam,
  readReactionParams,
  readStringParam,
  type OpenClawConfig,
  withNormalizedTimestamp,
} from "./runtime-api.js";
import { parseSlackTarget, resolveSlackChannelId } from "./targets.js";

const messagingActions = new Set([
  "sendMessage",
  "uploadFile",
  "editMessage",
  "deleteMessage",
  "readMessages",
  "downloadFile",
]);

const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);

function sameSlackChannelTarget(targetChannel: string, currentChannelId: string): boolean {
  const parsedTarget = parseSlackTarget(targetChannel, {
    defaultKind: "channel",
  });
  if (!parsedTarget || parsedTarget.kind !== "channel") {
    return false;
  }
  return (
    normalizeLowercaseStringOrEmpty(parsedTarget.id) ===
    normalizeLowercaseStringOrEmpty(currentChannelId)
  );
}

type SlackActionsRuntimeModule = typeof import("./actions.runtime.js");
type SlackAccountsRuntimeModule = typeof import("./accounts.runtime.js");

let slackActionsRuntimePromise: Promise<SlackActionsRuntimeModule> | undefined;
let slackAccountsRuntimePromise: Promise<SlackAccountsRuntimeModule> | undefined;

function loadSlackActionsRuntime(): Promise<SlackActionsRuntimeModule> {
  slackActionsRuntimePromise ??= import("./actions.runtime.js");
  return slackActionsRuntimePromise;
}

function loadSlackAccountsRuntime(): Promise<SlackAccountsRuntimeModule> {
  slackAccountsRuntimePromise ??= import("./accounts.runtime.js");
  return slackAccountsRuntimePromise;
}

function createLazySlackAction<K extends keyof SlackActionsRuntimeModule>(
  key: K,
): SlackActionsRuntimeModule[K] {
  return (async (...args: unknown[]) => {
    const runtime = await loadSlackActionsRuntime();
    const action = runtime[key] as (...actionArgs: unknown[]) => unknown;
    return action(...args);
  }) as SlackActionsRuntimeModule[K];
}

export const slackActionRuntime = {
  deleteSlackMessage: createLazySlackAction("deleteSlackMessage"),
  downloadSlackFile: createLazySlackAction("downloadSlackFile"),
  editSlackMessage: createLazySlackAction("editSlackMessage"),
  getSlackMemberInfo: createLazySlackAction("getSlackMemberInfo"),
  listSlackEmojis: createLazySlackAction("listSlackEmojis"),
  listSlackPins: createLazySlackAction("listSlackPins"),
  listSlackReactions: createLazySlackAction("listSlackReactions"),
  parseSlackBlocksInput,
  pinSlackMessage: createLazySlackAction("pinSlackMessage"),
  reactSlackMessage: createLazySlackAction("reactSlackMessage"),
  readSlackMessages: createLazySlackAction("readSlackMessages"),
  removeOwnSlackReactions: createLazySlackAction("removeOwnSlackReactions"),
  removeSlackReaction: createLazySlackAction("removeSlackReaction"),
  sendSlackMessage: createLazySlackAction("sendSlackMessage"),
  unpinSlackMessage: createLazySlackAction("unpinSlackMessage"),
};

export type SlackActionContext = {
  /** Current channel ID for auto-threading. */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string;
  /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent for single-use reply modes. */
  hasRepliedRef?: { value: boolean };
  /** True when same-channel root posting would leak a thread-originated reply. */
  sameChannelThreadRequired?: boolean;
  /** Allowed local media directories for file uploads. */
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

/**
 * Resolve threadTs for a Slack message based on context and replyToMode.
 * - "all": always inject threadTs
 * - "first"/"batched": inject only for the first eligible message (updates hasRepliedRef)
 * - "off": never auto-inject
 */
function resolveThreadTsFromContext(
  explicitThreadTs: string | undefined,
  targetChannel: string,
  context: SlackActionContext | undefined,
  opts?: { suppressImplicitThread?: boolean },
): string | undefined {
  // Agent explicitly provided threadTs - use it
  if (explicitThreadTs) {
    return explicitThreadTs;
  }
  if (opts?.suppressImplicitThread) {
    return undefined;
  }
  if (!context?.currentChannelId) {
    return undefined;
  }

  // Different channel - don't inject
  if (!sameSlackChannelTarget(targetChannel, context.currentChannelId)) {
    return undefined;
  }
  if (!context.currentThreadTs) {
    if (context.sameChannelThreadRequired) {
      throw new Error(
        "Slack thread context is required for same-channel replies from a threaded Slack turn. Set topLevel=true or threadId=null to post at the channel root.",
      );
    }
    return undefined;
  }

  // Check replyToMode
  if (context.replyToMode === "all") {
    return context.currentThreadTs;
  }
  if (
    isSingleUseReplyToMode(context.replyToMode ?? "off") &&
    context.hasRepliedRef &&
    !context.hasRepliedRef.value
  ) {
    context.hasRepliedRef.value = true;
    return context.currentThreadTs;
  }
  return undefined;
}

function readSlackBlocksParam(params: Record<string, unknown>) {
  return slackActionRuntime.parseSlackBlocksInput(params.blocks);
}

function isImageContentType(value: string | undefined): boolean {
  return value?.trim().toLowerCase().startsWith("image/") === true;
}

function assertSlackReadTargetAllowed(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
}) {
  const channels = params.account.config.channels;
  const channelKeys = Object.keys(channels ?? {});
  const channelConfig = resolveSlackChannelConfig({
    channelId: params.channelId,
    channels,
    channelKeys,
    allowNameMatching: params.account.config.dangerouslyAllowNameMatching,
    defaultRequireMention: params.account.config.requireMention,
  });
  const channelAllowed = channelConfig?.allowed !== false;
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.slack !== undefined,
    groupPolicy: params.account.config.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  if (
    groupPolicy === "disabled" ||
    (groupPolicy === "allowlist" &&
      !isSlackChannelAllowedByPolicy({
        groupPolicy,
        channelAllowlistConfigured: channelKeys.length > 0,
        channelAllowed,
      }))
  ) {
    throw new Error("Slack read target channel is not allowed.");
  }
  if (!channelAllowed && (groupPolicy !== "open" || channelConfig?.matchSource)) {
    throw new Error("Slack read target channel is not allowed.");
  }
}

export async function handleSlackAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  context?: SlackActionContext,
): Promise<AgentToolResult<unknown>> {
  const resolveChannelId = () =>
    resolveSlackChannelId(
      readStringParam(params, "channelId", {
        required: true,
      }),
    );
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const { resolveSlackAccount } = await loadSlackAccountsRuntime();
  const account = resolveSlackAccount({ cfg, accountId });
  const actionConfig = account.actions ?? cfg.channels?.slack?.actions;
  const isActionEnabled = createActionGate(actionConfig);
  const userToken = account.userToken;
  const botToken = account.botToken?.trim();
  const allowUserWrites = account.config.userTokenReadOnly === false;

  // Choose the most appropriate token for Slack read/write operations.
  const getTokenForOperation = (operation: "read" | "write") => {
    if (operation === "read") {
      return userToken ?? botToken;
    }
    if (!allowUserWrites) {
      return botToken;
    }
    return botToken ?? userToken;
  };

  const buildActionOpts = (operation: "read" | "write") => {
    const token = getTokenForOperation(operation);
    const tokenOverride = token && token !== botToken ? token : undefined;
    return {
      cfg,
      ...(accountId ? { accountId } : {}),
      ...(tokenOverride ? { token: tokenOverride } : {}),
    };
  };

  const readOpts = buildActionOpts("read");
  const writeOpts = buildActionOpts("write");

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Slack reactions are disabled.");
    }
    const channelId = resolveChannelId();
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Slack reaction.",
      });
      if (remove) {
        if (writeOpts) {
          await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji, writeOpts);
        } else {
          await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji);
        }
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = writeOpts
          ? await slackActionRuntime.removeOwnSlackReactions(channelId, messageId, writeOpts)
          : await slackActionRuntime.removeOwnSlackReactions(channelId, messageId);
        return jsonResult({ ok: true, removed });
      }
      if (writeOpts) {
        await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji, writeOpts);
      } else {
        await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji);
      }
      return jsonResult({ ok: true, added: emoji });
    }
    assertSlackReadTargetAllowed({ account, cfg, channelId });
    const reactions = readOpts
      ? await slackActionRuntime.listSlackReactions(channelId, messageId, readOpts)
      : await slackActionRuntime.listSlackReactions(channelId, messageId);
    return jsonResult({ ok: true, reactions });
  }

  if (messagingActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Slack messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const blocks = readSlackBlocksParam(params);
        const replyBroadcast = readBooleanParam(params, "replyBroadcast");
        if (!content && !mediaUrl && !blocks) {
          throw new Error("Slack sendMessage requires content, blocks, or mediaUrl.");
        }
        if (replyBroadcast && mediaUrl) {
          throw new Error(
            "Slack replyBroadcast is only supported for text or block thread replies.",
          );
        }
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
          {
            suppressImplicitThread: params.topLevel === true || params.threadTs === null,
          },
        );
        const sendOpts = {
          ...writeOpts,
          mediaLocalRoots: context?.mediaLocalRoots,
          mediaReadFile: context?.mediaReadFile,
          threadTs: threadTs ?? undefined,
          ...(replyBroadcast ? { replyBroadcast } : {}),
        };
        const result =
          mediaUrl && blocks
            ? await (async () => {
                await slackActionRuntime.sendSlackMessage(to, "", {
                  ...sendOpts,
                  mediaUrl,
                });
                return await slackActionRuntime.sendSlackMessage(to, content ?? "", {
                  ...sendOpts,
                  blocks,
                });
              })()
            : await slackActionRuntime.sendSlackMessage(to, content ?? "", {
                ...sendOpts,
                mediaUrl: mediaUrl ?? undefined,
                blocks,
              });

        // Keep "first" mode consistent even when the agent explicitly provided
        // threadTs: once we send a message to the current channel, consider the
        // first reply "used" so later tool calls don't auto-thread again.
        if (context?.hasRepliedRef && context.currentChannelId) {
          if (sameSlackChannelTarget(to, context.currentChannelId)) {
            context.hasRepliedRef.value = true;
          }
        }

        return jsonResult({ ok: true, result });
      }
      case "uploadFile": {
        const to = readStringParam(params, "to", { required: true });
        const filePath = readStringParam(params, "filePath", {
          required: true,
          trim: false,
        });
        const initialComment = readStringParam(params, "initialComment", {
          allowEmpty: true,
        });
        const filename = readStringParam(params, "filename");
        const title = readStringParam(params, "title");
        const replyBroadcast = readBooleanParam(params, "replyBroadcast");
        if (replyBroadcast) {
          throw new Error(
            "Slack replyBroadcast is only supported for text or block thread replies.",
          );
        }
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
          {
            suppressImplicitThread: params.topLevel === true || params.threadTs === null,
          },
        );
        const result = await slackActionRuntime.sendSlackMessage(to, initialComment ?? "", {
          ...writeOpts,
          mediaUrl: filePath,
          mediaLocalRoots: context?.mediaLocalRoots,
          mediaReadFile: context?.mediaReadFile,
          threadTs: threadTs ?? undefined,
          ...(filename ? { uploadFileName: filename } : {}),
          ...(title ? { uploadTitle: title } : {}),
        });

        if (context?.hasRepliedRef && context.currentChannelId) {
          if (sameSlackChannelTarget(to, context.currentChannelId)) {
            context.hasRepliedRef.value = true;
          }
        }

        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const blocks = readSlackBlocksParam(params);
        if (!content && !blocks) {
          throw new Error("Slack editMessage requires content or blocks.");
        }
        if (writeOpts) {
          await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
            ...writeOpts,
            blocks,
          });
        } else {
          await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
            blocks,
          });
        }
        return jsonResult({ ok: true });
      }
      case "deleteMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        if (writeOpts) {
          await slackActionRuntime.deleteSlackMessage(channelId, messageId, writeOpts);
        } else {
          await slackActionRuntime.deleteSlackMessage(channelId, messageId);
        }
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const channelId = resolveChannelId();
        assertSlackReadTargetAllowed({ account, cfg, channelId });
        const limit = readPositiveIntegerParam(params, "limit", {
          message: "limit must be a positive integer.",
        });
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const threadId = readStringParam(params, "threadId");
        const messageId = readStringParam(params, "messageId");
        const result = await slackActionRuntime.readSlackMessages(channelId, {
          ...readOpts,
          limit,
          before: before ?? undefined,
          after: after ?? undefined,
          threadId: threadId ?? undefined,
          messageId: messageId ?? undefined,
        });
        const messages = result.messages.map((message) =>
          withNormalizedTimestamp(
            message as Record<string, unknown>,
            (message as { ts?: unknown }).ts,
          ),
        );
        return jsonResult({ ok: true, messages, hasMore: result.hasMore });
      }
      case "downloadFile": {
        const fileId = readStringParam(params, "fileId", { required: true });
        const channelTarget =
          readStringParam(params, "channelId") ??
          readStringParam(params, "to") ??
          context?.currentChannelId;
        if (!channelTarget) {
          throw new Error(
            "Slack file download requires channelId or to so the read target can be authorized.",
          );
        }
        const channelId = resolveSlackChannelId(channelTarget);
        assertSlackReadTargetAllowed({ account, cfg, channelId });
        const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
        const maxBytes = account.config?.mediaMaxMb
          ? account.config.mediaMaxMb * 1024 * 1024
          : 20 * 1024 * 1024;
        const readToken = getTokenForOperation("read");
        const downloaded = await slackActionRuntime.downloadSlackFile(fileId, {
          ...readOpts,
          ...(readToken && !readOpts?.token ? { token: readToken } : {}),
          maxBytes,
          channelId,
          threadId: threadId ?? undefined,
        });
        if (!downloaded) {
          return jsonResult({
            ok: false,
            error: "File could not be downloaded (not found, too large, or inaccessible).",
          });
        }
        if (!isImageContentType(downloaded.contentType)) {
          return jsonResult({
            ok: true,
            fileId,
            path: downloaded.path,
            contentType: downloaded.contentType,
            placeholder: downloaded.placeholder,
            media: {
              mediaUrl: downloaded.path,
              outbound: false,
              ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
            },
          });
        }
        return await imageResultFromFile({
          label: "slack-file",
          path: downloaded.path,
          extraText: downloaded.placeholder,
          details: {
            fileId,
            path: downloaded.path,
            ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
            media: { outbound: false },
          },
        });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Slack pins are disabled.");
    }
    const channelId = resolveChannelId();
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (writeOpts) {
        await slackActionRuntime.pinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await slackActionRuntime.pinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (writeOpts) {
        await slackActionRuntime.unpinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await slackActionRuntime.unpinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    assertSlackReadTargetAllowed({ account, cfg, channelId });
    const pins = writeOpts
      ? await slackActionRuntime.listSlackPins(channelId, readOpts)
      : await slackActionRuntime.listSlackPins(channelId);
    const normalizedPins = pins.map((pin) => {
      const message = pin.message
        ? withNormalizedTimestamp(
            pin.message as Record<string, unknown>,
            (pin.message as { ts?: unknown }).ts,
          )
        : pin.message;
      return message ? Object.assign({}, pin, { message }) : pin;
    });
    return jsonResult({ ok: true, pins: normalizedPins });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Slack member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const info = writeOpts
      ? await slackActionRuntime.getSlackMemberInfo(userId, readOpts)
      : await slackActionRuntime.getSlackMemberInfo(userId);
    return jsonResult({ ok: true, info });
  }

  if (action === "emojiList") {
    if (!isActionEnabled("emojiList")) {
      throw new Error("Slack emoji list is disabled.");
    }
    const limit = readPositiveIntegerParam(params, "limit", {
      message: "limit must be a positive integer.",
    });
    const result = readOpts
      ? await slackActionRuntime.listSlackEmojis(readOpts)
      : await slackActionRuntime.listSlackEmojis();
    if (limit != null && limit > 0 && result.emoji != null) {
      const entries = Object.entries(result.emoji).toSorted(([a], [b]) => a.localeCompare(b));
      if (entries.length > limit) {
        return jsonResult({
          ok: true,
          emojis: {
            ...result,
            emoji: Object.fromEntries(entries.slice(0, limit)),
          },
        });
      }
    }
    return jsonResult({ ok: true, emojis: result });
  }

  throw new Error(`Unknown action: ${action}`);
}
