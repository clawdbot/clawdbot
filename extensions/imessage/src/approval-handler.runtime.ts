// Imessage plugin module implements approval handler behavior.
import { setTimeout as delay } from "node:timers/promises";
import {
  buildChannelApprovalExpiredText,
  buildChannelApprovalResolvedText,
  createChannelApprovalNativeRuntimeAdapter,
  type PendingApprovalView,
  resolvePreparedApprovalAccountId,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildApprovalNativeControlsPromptText,
  buildApprovalReactionPendingContent,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveIMessageAccount } from "./accounts.js";
import { getIMessageApprovalApprovers } from "./approval-auth.js";
import { iMessageApprovalControlBindings } from "./approval-control-binding-window.js";
import {
  buildApprovalPollOptions,
  iMessageApprovalPollTargets,
  mapSentPollOptionsToDecisions,
} from "./approval-polls.js";
import {
  buildIMessageApprovalConversationKeyForTarget,
  registerIMessageApprovalReactionTarget,
  unregisterIMessageApprovalReactionTarget,
  type IMessageApprovalConversationKey,
} from "./approval-reactions.js";
import { extractMarkdownFormatRuns } from "./markdown-format.js";
import { normalizeIMessageMessagingTarget } from "./normalize.js";
import { getCachedIMessagePrivateApiStatus } from "./probe.js";
import { sendMessageIMessage } from "./send.js";
import { parseIMessageTarget } from "./targets.js";

const log = createSubsystemLogger("imessage/approvals");

const loadIMessageActionsRuntime = createLazyRuntimeNamedExport(
  () => import("./actions.runtime.js"),
  "imessageActionsRuntime",
);

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
// Messages timestamps text and extension-balloon sends asynchronously. A short
// gap keeps a poll posted second from sorting above the approval it follows.
const APPROVAL_POLL_ORDERING_DELAY_MS = 1_100;

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type IMessagePendingDelivery = {
  /** Prompt text carrying the tapback hint; used when no poll will be sent. */
  text: string;
  /**
   * Poll-mode prompt: no tapback hint, but keeps `/approve` commands for
   * recipients whose older Apple clients cannot render the poll balloon.
   */
  pollText: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};
type PreparedIMessageApprovalTarget = {
  to: string;
  accountId?: string;
};
type IMessageApprovalPromptBinding = {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};
type PendingIMessageApprovalEntry = {
  accountId?: string;
  to: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  /** Follow-up carrying the tapback hint when an expected poll failed to send. */
  hintMessageId?: string;
  /** The details message advertised tapbacks even though a poll also exists. */
  reactionFallbackVisible?: boolean;
  poll?: {
    pollGuid?: string;
    optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
  };
};
type IMessageFinalPayload = {
  text: string;
};

function buildPendingPayload(params: {
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): IMessagePendingDelivery {
  const pendingContent = buildApprovalReactionPendingContent({
    request: params.request,
    view: params.view as never,
    nowMs: params.nowMs,
  });
  return {
    text: pendingContent.reactionPayload.text ?? "",
    // The native poll owns the primary controls. Manual commands stay in the
    // details message because bridge capability cannot prove recipient support.
    // Same bold headers and labels as the tapback prompt (#85954): both are
    // delivered through the attributed-body send path.
    pollText: buildApprovalNativeControlsPromptText({ view: params.view, nowMs: params.nowMs }),
    allowedDecisions: pendingContent.reactionPayload.allowedDecisions,
  };
}

type IMessageApprovalTargetTransport = "imessage" | "sms" | "unknown";

function classifyIMessageApprovalTargetTransport(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
}): IMessageApprovalTargetTransport {
  const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.target.accountId });
  const parsedTarget = parseIMessageTarget(params.target.to);
  if (parsedTarget.kind === "handle") {
    if (parsedTarget.service === "imessage" || parsedTarget.service === "sms") {
      return parsedTarget.service;
    }
    return account.config.service === "imessage" || account.config.service === "sms"
      ? account.config.service
      : "unknown";
  }
  const conversationId =
    parsedTarget.kind === "chat_guid"
      ? parsedTarget.chatGuid
      : parsedTarget.kind === "chat_identifier"
        ? parsedTarget.chatIdentifier
        : "";
  if (/^iMessage;/i.test(conversationId)) {
    return "imessage";
  }
  if (/^SMS;/i.test(conversationId)) {
    return "sms";
  }
  return "unknown";
}

/**
 * Cache-only capability check, run before the prompt is sent so the tapback hint
 * can be omitted up front. Deliberately never probes: a probe spawns imsg and
 * would put seconds of latency in front of an approval prompt. An available
 * bridge status is cached for the process lifetime (see probe.ts), so the only
 * cost of a cold cache is that the first approval after start uses tapbacks.
 */
function canIMessageApprovalUsePoll(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
  plannedTarget: { surface: string };
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): boolean {
  // Explicit forwarding is owned by the generic forwarding path, not native
  // channel delivery. Keep this gate fail-closed if that surface is ever
  // carried into the native runtime.
  if (params.plannedTarget.surface !== "origin" && params.plannedTarget.surface !== "approver-dm") {
    return false;
  }
  // Messages requires at least two options; a single-decision approval stays
  // text-only rather than being padded with a fake choice.
  if (buildApprovalPollOptions({ allowedDecisions: params.allowedDecisions }).length < 2) {
    return false;
  }
  try {
    const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.target.accountId });
    if (
      classifyIMessageApprovalTargetTransport({
        cfg: params.cfg,
        target: params.target,
      }) === "sms"
    ) {
      return false;
    }
    if (
      !createActionGate(account.config.actions)("polls") ||
      getIMessageApprovalApprovers({
        cfg: params.cfg,
        accountId: account.accountId,
      }).length === 0
    ) {
      return false;
    }
    const cliPath = account.config.cliPath?.trim() || "imsg";
    const status = getCachedIMessagePrivateApiStatus(cliPath);
    return (
      status?.available === true &&
      status?.selectors?.pollPayloadMessage === true &&
      status.cliCapabilities?.pollSendSupportsNoComment === true
    );
  } catch {
    return false;
  }
}

function resolveIMessageApprovalCliOptions(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
}): { cliPath: string; dbPath?: string; timeoutMs?: number } {
  const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.target.accountId });
  return {
    cliPath: account.config.cliPath?.trim() || "imsg",
    dbPath: account.config.dbPath?.trim() || undefined,
    timeoutMs: account.config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  };
}

/**
 * Send the poll balloon after the approval details prompt. imsg normally echoes
 * every poll question as a separate caption after the balloon; suppress that
 * echo because OpenClaw already rendered the full context above the controls.
 *
 * Conversation-read authority: `chatGuid` is resolved from the approval's own
 * routing target (origin session or a configured approver), so this read is
 * host-originated and carries the server-owned direct-operator attestation.
 *
 */
async function deliverIMessageApprovalPoll(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  expiresAtMs: number;
  question: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): Promise<{
  pollGuid?: string;
  chatGuid: string;
  optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
} | null> {
  const options = buildApprovalPollOptions({ allowedDecisions: params.allowedDecisions });
  try {
    const cliOptions = resolveIMessageApprovalCliOptions({
      cfg: params.cfg,
      target: params.target,
    });
    const chatGuid = await resolveIMessageApprovalChatGuid({
      to: params.target.to,
      cliOptions,
    });
    // chat_id and unprefixed identifiers do not carry their transport. Resolve
    // them before sending controls, then fail back to text for an SMS chat.
    if (!chatGuid || /^SMS;/i.test(chatGuid)) {
      return null;
    }
    await delay(APPROVAL_POLL_ORDERING_DELAY_MS);
    const runtime = await loadIMessageActionsRuntime();
    const sent = await runtime.sendPoll({
      chatGuid,
      // `imsg poll send --question` has no attributed-body channel, so the
      // question keeps the marker-free rendering of the same prompt copy the
      // details message delivers with typed formatting ranges.
      question: extractMarkdownFormatRuns(params.question).text,
      choices: options.map((option) => option.text),
      suppressComment: true,
      options: { ...cliOptions, chatGuid },
    });
    const reportedGuid = sent.messageId.trim();
    const pollGuid =
      reportedGuid && reportedGuid !== "ok" && reportedGuid !== "unknown"
        ? reportedGuid
        : undefined;
    const optionDecisions = mapSentPollOptionsToDecisions({
      requested: options,
      sent: sent.pollOptions,
    });
    if (optionDecisions.length !== options.length) {
      // The companion imsg contract creates and returns every option UUID in
      // the same operation. Do not guess or retract its racy messageGuid when
      // that contract is violated. Leave the unbound poll inert and restore the
      // complete text fallback so delivery is not retried and duplicated.
      log.error("imessage approvals: imsg poll response did not return a complete option mapping");
      iMessageApprovalPollTargets.registerTombstone({
        accountId: resolveIMessageAccount({
          cfg: params.cfg,
          accountId: params.target.accountId,
        }).accountId,
        conversation: { chatGuid },
        ...(pollGuid ? { pollGuid } : {}),
        optionIds: sent.pollOptions.map((option) => option.id),
        approvalId: params.approvalId,
      });
      return null;
    }
    const accountId = resolveIMessageAccount({
      cfg: params.cfg,
      accountId: params.target.accountId,
    }).accountId;
    const registered = iMessageApprovalPollTargets.register({
      accountId,
      conversation: { chatGuid },
      ...(pollGuid ? { pollGuid } : {}),
      approvalId: params.approvalId,
      approvalKind: params.approvalKind,
      optionDecisions,
      expiresAtMs: params.expiresAtMs,
    });
    if (!registered) {
      iMessageApprovalPollTargets.registerTombstone({
        accountId,
        conversation: { chatGuid },
        ...(pollGuid ? { pollGuid } : {}),
        optionIds: optionDecisions.map(([optionId]) => optionId),
        approvalId: params.approvalId,
      });
      log.error("imessage approvals: poll target could not be registered");
      return null;
    }
    // imsg 0.13.1 can report the previously sent message while the poll row is
    // still being inserted. Option UUIDs come from the poll payload itself and
    // are therefore the stable vote correlation identity.
    return {
      ...(pollGuid ? { pollGuid } : {}),
      chatGuid,
      optionDecisions,
    };
  } catch (error) {
    log.warn(`imessage approvals: poll send failed, falling back to tapbacks: ${String(error)}`);
    return null;
  }
}

/**
 * Polls must target a chat Messages already knows. Unlike send, we never
 * synthesize an unregistered DM identifier here: the bridge would reject it and
 * the poll would be lost.
 */
async function resolveIMessageApprovalChatGuid(params: {
  to: string;
  cliOptions: { cliPath: string; dbPath?: string; timeoutMs?: number };
}): Promise<string | null> {
  const target = parseIMessageTarget(params.to);
  if (target.kind === "chat_guid") {
    return target.chatGuid;
  }
  const runtime = await loadIMessageActionsRuntime();
  if (target.kind === "chat_id" || target.kind === "chat_identifier") {
    return await runtime.resolveChatGuidForTarget({
      target,
      options: params.cliOptions,
      conversationReadOrigin: "direct-operator",
    });
  }
  if (target.kind !== "handle") {
    return null;
  }
  const service = target.service === "sms" ? "SMS" : "iMessage";
  return await runtime.resolveChatGuidForTarget({
    target: { kind: "chat_identifier", chatIdentifier: `${service};-;${target.to}` },
    options: params.cliOptions,
    conversationReadOrigin: "direct-operator",
  });
}

/**
 * The prompt went out without its tapback hint because a poll was expected.
 * If poll delivery fails, restore the complete reaction fallback while the
 * original details message still carries every manual command.
 */
async function recoverIMessageApprovalTextFallback(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
  promptMessageId?: string;
  fallbackText: string;
  approvalPrompt: IMessageApprovalPromptBinding;
}): Promise<string | undefined> {
  try {
    const result = await sendMessageIMessage(params.target.to, params.fallbackText, {
      config: params.cfg,
      approvalPrompt: params.approvalPrompt,
      conversationReadOrigin: "direct-operator",
      ...(params.target.accountId ? { accountId: params.target.accountId } : {}),
      ...(params.promptMessageId ? { replyToId: params.promptMessageId } : {}),
    });
    return result.guid;
  } catch (error) {
    log.error(`imessage approvals: text-fallback recovery failed: ${String(error)}`);
    return undefined;
  }
}

/** Clear both controls together; a stale binding would resolve a dead approval. */
function clearIMessageApprovalBindings(entry: PendingIMessageApprovalEntry): void {
  const accountId = entry.accountId?.trim();
  if (!accountId) {
    return;
  }
  for (const messageId of [entry.messageId, entry.hintMessageId]) {
    if (messageId && (!entry.poll || entry.reactionFallbackVisible)) {
      unregisterIMessageApprovalReactionTarget({
        accountId,
        conversation: entry.conversation,
        messageId,
      });
    }
  }
  if (entry.poll) {
    iMessageApprovalPollTargets.unregister({
      accountId,
      conversation: entry.conversation,
      pollGuid: entry.poll.pollGuid,
      optionDecisions: entry.poll.optionDecisions,
    });
  }
}

function shouldThreadApprovalUpdate(to: string): boolean {
  try {
    const parsed = parseIMessageTarget(to);
    if (parsed.kind === "handle" && parsed.service === "sms") {
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

const eagerlyBoundApprovalEntries = new WeakSet<PendingIMessageApprovalEntry>();

function bindIMessageApprovalEntry(params: {
  entry: PendingIMessageApprovalEntry;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  expiresAtMs: number;
  pollTargetWasRegisteredDuringDelivery?: boolean;
}): true | null {
  const accountId = params.entry.accountId?.trim();
  if (!accountId) {
    log.error(
      `imessage approvals: refusing to bind reaction target for ${params.approvalId}; missing accountId in prepared entry`,
    );
    return null;
  }
  const ttlMs = params.expiresAtMs - Date.now();
  if (ttlMs <= 0) {
    log.error(
      `imessage approvals: refusing to bind reaction target for ${params.approvalId}; approval already expired at bind time`,
    );
    return null;
  }
  const reactionBound =
    params.entry.poll && !params.entry.reactionFallbackVisible
      ? false
      : [params.entry.messageId, params.entry.hintMessageId]
          .filter((messageId): messageId is string => Boolean(messageId))
          .map((messageId) =>
            registerIMessageApprovalReactionTarget({
              accountId,
              conversation: params.entry.conversation,
              messageId,
              approvalId: params.approvalId,
              approvalKind: params.approvalKind,
              allowedDecisions: params.allowedDecisions,
              ttlMs,
            }),
          )
          .some(Boolean);
  const pollBound = params.entry.poll
    ? params.pollTargetWasRegisteredDuringDelivery ||
      iMessageApprovalPollTargets.register({
        accountId,
        conversation: params.entry.conversation,
        pollGuid: params.entry.poll.pollGuid,
        approvalId: params.approvalId,
        approvalKind: params.approvalKind,
        optionDecisions: params.entry.poll.optionDecisions,
        expiresAtMs: params.expiresAtMs,
      })
    : false;
  return reactionBound || pollBound ? true : null;
}

export const imessageApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  IMessagePendingDelivery,
  PreparedIMessageApprovalTarget,
  PendingIMessageApprovalEntry,
  true,
  IMessageFinalPayload
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: ({ context }) => Boolean(context),
    shouldHandle: ({ context }) => Boolean(context),
  },
  presentation: {
    buildPendingPayload: ({ request, approvalKind, nowMs, view }) =>
      buildPendingPayload({ request, approvalKind, nowMs, view }),
    buildResolvedResult: ({ request, resolved, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalResolvedText({ request, resolved, view }) },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalExpiredText({ request, view }) },
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget, accountId }) => {
      const to = normalizeIMessageMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const prepared: PreparedIMessageApprovalTarget = {
        to,
        accountId: resolvePreparedApprovalAccountId({
          plannedAccountId: (plannedTarget.target as { accountId?: string | null }).accountId,
          contextAccountId: accountId,
        }),
      };
      return {
        dedupeKey: `${prepared.accountId ?? ""}:${buildChannelApprovalNativeTargetKey({
          to: prepared.to,
        })}`,
        target: prepared,
      };
    },
    deliverPending: async ({ cfg, preparedTarget, plannedTarget, pendingPayload, view }) => {
      // Capability reads are cache-only. Render the context first, then place
      // native controls below it without imsg's trailing caption echo.
      const expectPoll = canIMessageApprovalUsePoll({
        cfg,
        target: preparedTarget,
        plannedTarget,
        allowedDecisions: pendingPayload.allowedDecisions,
      });
      const conversation = buildIMessageApprovalConversationKeyForTarget(preparedTarget.to);
      if (!conversation) {
        return null;
      }
      const accountId = resolveIMessageAccount({
        cfg,
        accountId: preparedTarget.accountId,
      }).accountId;
      const bindingWindow = iMessageApprovalControlBindings.begin({ accountId, conversation });
      try {
        const targetTransport = expectPoll
          ? classifyIMessageApprovalTargetTransport({ cfg, target: preparedTarget })
          : "unknown";
        // Unknown targets include chat_id and auto handles. Keep the reaction
        // fallback visible until the send receipt confirms the actual transport.
        const reactionFallbackVisible = !expectPoll || targetTransport !== "imessage";
        const promptText = reactionFallbackVisible ? pendingPayload.text : pendingPayload.pollText;
        const approvalPrompt: IMessageApprovalPromptBinding = {
          approvalId: view.approvalId,
          approvalKind: view.approvalKind,
          allowedDecisions: pendingPayload.allowedDecisions,
        };
        const result = await sendMessageIMessage(preparedTarget.to, promptText, {
          config: cfg,
          ...(reactionFallbackVisible ? { approvalPrompt } : {}),
          // Approval delivery is host-originated: the target comes from the
          // approval's own routing (origin session or a configured approver),
          // never from model input. Attest that so #99905's conversation-read
          // policy sees the real authority instead of failing closed to
          // "delegated". If the target ever becomes caller-influenced, this
          // must go back to delegated.
          conversationReadOrigin: "direct-operator",
          ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
        });
        if (!result.guid) {
          // A numeric ROWID cannot bind inbound reactions or anchor the poll.
          // The poll-mode details still carry `/approve`, so return without
          // duplicating the prompt and leave manual commands available.
          return null;
        }
        const confirmedTransport =
          result.service ??
          (result.chatGuid && /^iMessage;/i.test(result.chatGuid)
            ? "imessage"
            : result.chatGuid && /^SMS;/i.test(result.chatGuid)
              ? "sms"
              : targetTransport);
        const poll =
          expectPoll && confirmedTransport === "imessage"
            ? await deliverIMessageApprovalPoll({
                cfg,
                target: preparedTarget,
                approvalId: view.approvalId,
                approvalKind: view.approvalKind,
                expiresAtMs: view.expiresAtMs,
                question: pendingPayload.pollText,
                allowedDecisions: pendingPayload.allowedDecisions,
              })
            : null;
        const hintMessageId =
          expectPoll && !poll && !reactionFallbackVisible
            ? await recoverIMessageApprovalTextFallback({
                cfg,
                target: preparedTarget,
                promptMessageId: result.guid,
                fallbackText: pendingPayload.text,
                approvalPrompt,
              })
            : undefined;
        const entry: PendingIMessageApprovalEntry = {
          accountId,
          to: preparedTarget.to,
          conversation: poll ? { ...conversation, chatGuid: poll.chatGuid } : conversation,
          messageId: result.guid,
          ...(hintMessageId ? { hintMessageId } : {}),
          ...(poll && reactionFallbackVisible ? { reactionFallbackVisible: true } : {}),
          ...(poll
            ? {
                poll: {
                  ...(poll.pollGuid ? { pollGuid: poll.pollGuid } : {}),
                  optionDecisions: poll.optionDecisions,
                },
              }
            : {}),
        };
        const bound = bindIMessageApprovalEntry({
          entry,
          approvalId: view.approvalId,
          approvalKind: view.approvalKind,
          allowedDecisions: pendingPayload.allowedDecisions,
          expiresAtMs: view.expiresAtMs,
          // Poll delivery registers before returning so an immediate vote can
          // overtake the blocked chat lane. Never recreate that target here:
          // the vote may already have resolved and removed it at this await.
          pollTargetWasRegisteredDuringDelivery: Boolean(entry.poll),
        });
        if (bound) {
          // Generic bindPending runs after delivery. Mark this exact entry so
          // it acknowledges the eager bind without recreating a target that an
          // inbound control may already have resolved and removed.
          eagerlyBoundApprovalEntries.add(entry);
        }
        return entry;
      } finally {
        bindingWindow.close();
      }
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await sendMessageIMessage(entry.to, payload.text, {
        config: cfg,
        // The entry and reply target were created by this host-owned approval
        // delivery. Preserve that authority when cache/database proof is gone.
        conversationReadOrigin: "direct-operator",
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
        ...(shouldThreadApprovalUpdate(entry.to) ? { replyToId: entry.messageId } : {}),
      });
    },
  },
  interactions: {
    bindPending: ({ entry, request, view, pendingPayload }) => {
      if (eagerlyBoundApprovalEntries.delete(entry)) {
        return true;
      }
      return bindIMessageApprovalEntry({
        entry,
        approvalId: request.id,
        approvalKind: view.approvalKind,
        allowedDecisions: pendingPayload.allowedDecisions,
        expiresAtMs: view.expiresAtMs,
      });
    },
    unbindPending: ({ entry }) => {
      clearIMessageApprovalBindings(entry);
    },
    cancelDelivered: ({ entry }) => {
      clearIMessageApprovalBindings(entry);
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`imessage approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
