// Imessage plugin module implements approval reactions behavior.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  addApprovalReactionHintToText,
  approvalReactionDecisionSetsMatch,
  buildApprovalReactionHint,
  buildApprovalReactionDeliveredBindingMarker,
  createApprovalReactionTargetStore,
  listApprovalReactionBindings,
  normalizeApprovalReactionDecision,
  readApprovalReactionDecisionList,
  readApprovalReactionDeliveredBinding,
  readApprovalReactionPresentationBinding,
  resolveTypedApprovalReactionTarget,
  type ApprovalReactionDeliveryBinding,
  type ApprovalReactionTargetRecord,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";
import type { IMessageApprovalGatewayRuntime } from "./approval-gateway-types.js";
import {
  clearIMessageApprovalReactionPollTargetsForTest,
  deleteIMessageApprovalReactionPollTargets,
  recordIMessageApprovalReactionPollTarget,
} from "./approval-reaction-poll-targets.js";
import {
  buildIMessageApprovalConversationKeyForInbound,
  buildIMessageApprovalConversationKeyForTarget,
  enumerateApprovalTargetKeys,
  normalizeConversationKey,
  type IMessageApprovalConversationKey,
} from "./approval-target-keys.js";
import { resolveIMessageReactionContext } from "./monitor/reaction-context.js";
import type { IMessagePayload } from "./monitor/types.js";
import { getOptionalIMessageRuntime } from "./runtime.js";
import { normalizeIMessageHandle } from "./targets.js";

const PERSISTENT_NAMESPACE = "imessage.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

type IMessageApprovalReactionResolution = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  decision: ExecApprovalReplyDecision;
};
type IMessageApprovalReactionHandleResult =
  | { handled: false; stopPolling: false }
  | { handled: true; stopPolling: false }
  | {
      handled: true;
      stopPolling: true;
      stopPollingReason: "resolved" | "not-found";
    };

type IMessageApprovalReactionTarget = ApprovalReactionTargetRecord & {
  approvalKind: ChannelApprovalKind;
};

export type { IMessageApprovalConversationKey } from "./approval-target-keys.js";

const loadResolveApprovalOverGateway = createLazyRuntimeSurface(
  () => import("openclaw/plugin-sdk/approval-gateway-runtime"),
  (runtime) => runtime.resolveApprovalOverGateway,
);
const reportPersistentApprovalReactionError = createPluginStateErrorReporter(
  getOptionalIMessageRuntime,
  "imessage",
  "approval-reaction-state",
  "iMessage persistent approval reaction state failed",
);

function reportApprovalBindingCorrelationMismatch(binding: {
  approvalId: string;
  approvalKind: string;
}): void {
  // Fail closed but never silently: prompt text colliding with the marker
  // lines (or chunked delivery) would otherwise disable tapback approvals
  // with no operator signal.
  try {
    getOptionalIMessageRuntime()
      ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-reaction-state" })
      .warn("iMessage approval prompt text failed binding correlation; tapbacks disabled", {
        approvalId: binding.approvalId,
        approvalKind: binding.approvalKind,
      });
  } catch {
    // Best effort only.
  }
}

function readPersistedTarget(value: unknown): IMessageApprovalReactionTarget | null {
  const target = value as Partial<IMessageApprovalReactionTarget> | undefined;
  if (
    !target ||
    typeof target.approvalId !== "string" ||
    (target.approvalKind !== "exec" && target.approvalKind !== "plugin")
  ) {
    return null;
  }
  const allowedDecisions = readApprovalReactionDecisionList(target.allowedDecisions);
  if (!allowedDecisions) {
    return null;
  }
  return {
    approvalId: target.approvalId,
    approvalKind: target.approvalKind,
    allowedDecisions,
  };
}

const imessageApprovalReactionTargets =
  createApprovalReactionTargetStore<IMessageApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (params) => getOptionalIMessageRuntime()?.state.openKeyedStore(params),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

type IMessageApprovalDeliveryBinding = ApprovalReactionDeliveryBinding & {
  approvalSlug: string;
};

const IMESSAGE_APPROVAL_DELIVERY_BINDING_KEY = "imessageApprovalReactionBindingV1";

function visibleApprovalBindingMatches(
  text: string | undefined,
  binding: IMessageApprovalDeliveryBinding,
  options: { requireReactionHint: boolean },
): boolean {
  if (!text) {
    return false;
  }
  // Approval prompts carry bold markers (**Header**, **ID:** …). Strip them
  // before matching so reaction binding still correlates the delivered prompt.
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\*\*/g, "").trim());
  const normalizedHeaders = lines.map((line) => line.replace(/^[^A-Za-z0-9]*/, ""));
  const hasKindHeader =
    binding.approvalKind === "exec"
      ? lines.includes("Approval required.") ||
        normalizedHeaders.some((line) => /^Exec approval required$/i.test(line))
      : normalizedHeaders.some((line) => /^Plugin approval required$/i.test(line));
  const hasId =
    lines.includes(`ID: ${binding.approvalId}`) ||
    lines.includes(`Full id: \`${binding.approvalId}\``) ||
    lines.includes(`Full id: ${binding.approvalId}`);
  if (!hasKindHeader || !hasId) {
    return false;
  }
  const visibleDecisions: ExecApprovalReplyDecision[] = [];
  for (const line of lines) {
    const match = line.match(APPROVE_COMMAND_LINE_RE);
    const approvalId = match?.[1];
    const decisionsText = match?.[2];
    if (
      !approvalId ||
      !decisionsText ||
      (approvalId !== binding.approvalId && approvalId !== binding.approvalSlug)
    ) {
      continue;
    }
    for (const token of decisionsText.split(/[\s|,]+/)) {
      const decision = normalizeApprovalReactionDecision(token);
      if (decision && !visibleDecisions.includes(decision)) {
        visibleDecisions.push(decision);
      }
    }
  }
  if (!approvalReactionDecisionSetsMatch(binding.allowedDecisions, visibleDecisions)) {
    return false;
  }
  if (!options.requireReactionHint) {
    return true;
  }
  const hint = buildApprovalReactionHint({ allowedDecisions: binding.allowedDecisions });
  return Boolean(hint && text.includes(hint));
}

/** Preserve a validated typed approval binding until the iMessage GUID is known. */
export function addIMessageApprovalReactionHintToStructuredPayload(params: {
  payload: ReplyPayload;
  approvalKind: ChannelApprovalKind;
}): ReplyPayload | null {
  const metadata = readApprovalReactionPresentationBinding({
    payload: params.payload,
    requireApprovalSlug: true,
    trimApprovalId: true,
  }) as IMessageApprovalDeliveryBinding | null;
  const text = params.payload.text;
  if (metadata?.approvalKind !== params.approvalKind || !text) {
    return null;
  }
  if (!visibleApprovalBindingMatches(text, metadata, { requireReactionHint: false })) {
    reportApprovalBindingCorrelationMismatch(metadata);
    return null;
  }
  return {
    ...params.payload,
    text: addApprovalReactionHintToText({
      text,
      allowedDecisions: metadata.allowedDecisions,
    }),
    channelData: {
      ...params.payload.channelData,
      [IMESSAGE_APPROVAL_DELIVERY_BINDING_KEY]: buildApprovalReactionDeliveredBindingMarker({
        approvalId: metadata.approvalId,
        approvalSlug: metadata.approvalSlug,
        approvalKind: metadata.approvalKind,
        allowedDecisions: metadata.allowedDecisions,
      }),
    },
  };
}

const APPROVE_COMMAND_LINE_RE = /\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+)$/i;

export function registerIMessageApprovalReactionTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): IMessageApprovalReactionTarget | null {
  const accountId = params.accountId.trim();
  const messageId = params.messageId.trim();
  const approvalId = params.approvalId.trim();
  const allowedDecisions = listApprovalReactionBindings({
    allowedDecisions: params.allowedDecisions,
  }).map((binding) => binding.decision);
  if (
    !accountId ||
    !messageId ||
    !approvalId ||
    (params.approvalKind !== "exec" && params.approvalKind !== "plugin") ||
    allowedDecisions.length === 0
  ) {
    return null;
  }
  const target = { approvalId, approvalKind: params.approvalKind, allowedDecisions };
  // Register the binding under every key we can derive from the conversation
  // (chat_guid / chat_identifier / chat_id / handle). Inbound lookup precedence
  // can differ from outbound — e.g. send only sees `{handle: "+1..."}` for a
  // DM target, while the bridge populates chat_guid on the inbound tapback.
  // Indexing under every available key keeps send/inbound symmetric without
  // forcing the caller to know which key the bridge will pick.
  const keys = enumerateApprovalTargetKeys({
    accountId,
    conversation: params.conversation,
    messageId,
  });
  if (keys.length === 0) {
    return null;
  }
  const expiry = recordIMessageApprovalReactionPollTarget({
    keys,
    accountId,
    conversation: params.conversation,
    messageId,
    approvalId,
    approvalKind: params.approvalKind,
    allowedDecisions,
    ttlMs: params.ttlMs,
  });
  if (!expiry) {
    return null;
  }
  for (const key of keys) {
    imessageApprovalReactionTargets.register(key, target, { ttlMs: expiry.ttlMs });
  }
  return target;
}

export { buildIMessageApprovalConversationKeyForTarget };

function listDeliveredIMessageApprovalGuids(params: {
  binding: IMessageApprovalDeliveryBinding;
  results: readonly OutboundDeliveryResult[];
}): string[] {
  const deliveries: Array<{ guid: string; visibleText: string }> = [];
  const seen = new Set<string>();
  for (const result of params.results) {
    if (result.channel !== "imessage") {
      continue;
    }
    const guid =
      typeof result.meta?.imessageMessageGuid === "string"
        ? result.meta.imessageMessageGuid.trim()
        : "";
    const visibleText = result.meta?.imessageVisibleText;
    if (!guid || /^\d+$/.test(guid) || seen.has(guid) || typeof visibleText !== "string") {
      continue;
    }
    seen.add(guid);
    deliveries.push({ guid, visibleText });
  }
  // Outbound chunking can split the ID, reaction hint, and command across
  // messages. Correlate the ordered delivery as one prompt before binding its GUIDs.
  const visiblePrompt = deliveries.map((delivery) => delivery.visibleText).join("\n");
  if (
    !visibleApprovalBindingMatches(visiblePrompt, params.binding, { requireReactionHint: true })
  ) {
    if (params.results.some((result) => result.channel === "imessage")) {
      reportApprovalBindingCorrelationMismatch(params.binding);
    }
    return [];
  }
  return deliveries.map((delivery) => delivery.guid);
}

/** Bind a typed forwarded approval after iMessage returns the stable tapback GUID. */
export function registerIMessageApprovalReactionTargetForDeliveredPayload(params: {
  accountId: string;
  target: { channel: string; to: string };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
  ttlMs?: number;
}): boolean {
  if (params.target.channel.trim().toLowerCase() !== "imessage") {
    return false;
  }
  const binding = readApprovalReactionDeliveredBinding({
    payload: params.payload,
    channelDataKey: IMESSAGE_APPROVAL_DELIVERY_BINDING_KEY,
    requireApprovalSlug: true,
    trimApprovalId: true,
  }) as IMessageApprovalDeliveryBinding | null;
  if (!binding) {
    return false;
  }
  const conversation = buildIMessageApprovalConversationKeyForTarget(params.target.to);
  if (!conversation) {
    return false;
  }
  let registered = false;
  for (const messageId of listDeliveredIMessageApprovalGuids({
    binding,
    results: params.results,
  })) {
    registered =
      Boolean(
        registerIMessageApprovalReactionTarget({
          accountId: params.accountId,
          conversation,
          messageId,
          approvalId: binding.approvalId,
          approvalKind: binding.approvalKind,
          allowedDecisions: binding.allowedDecisions,
          ttlMs: params.ttlMs,
        }),
      ) || registered;
  }
  return registered;
}

export function unregisterIMessageApprovalReactionTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
}): void {
  const keys = enumerateApprovalTargetKeys(params);
  for (const key of keys) {
    imessageApprovalReactionTargets.delete(key);
  }
  deleteIMessageApprovalReactionPollTargets(keys);
}

function resolveTarget(params: {
  target: IMessageApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): IMessageApprovalReactionResolution | null {
  const target = resolveTypedApprovalReactionTarget(params);
  return target
    ? {
        approvalId: target.approvalId,
        approvalKind: target.approvalKind,
        decision: target.decision,
      }
    : null;
}

function formatCanonicalApprovalTerminalState(approval: ApprovalResolveResult["approval"]): string {
  const decision =
    approval.status === "allowed" || approval.status === "denied"
      ? ` decision=${approval.decision}`
      : "";
  return `status=${approval.status}${decision} reason=${approval.reason}`;
}

export async function resolveIMessageApprovalReactionTargetWithPersistence(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  reactionKey: string;
}): Promise<IMessageApprovalReactionResolution | null> {
  // Try every key we can derive from the inbound payload. Send-side may have
  // registered only `handle:`, while the inbound payload carries chat_guid
  // (the bridge sets chat_guid even for DMs). We probe in precedence order
  // (chat_guid → chat_identifier → chat_id → handle) and accept the first hit.
  const keys = enumerateApprovalTargetKeys(params);
  for (const key of keys) {
    const target = resolveTarget({
      target: await imessageApprovalReactionTargets.lookup(key),
      reactionKey: params.reactionKey,
    });
    if (target) {
      return target;
    }
  }
  return null;
}

type IMessageApprovalReactionEvent = {
  conversation: IMessageApprovalConversationKey;
  /** Primary candidate (the normalized targetGuid form). */
  messageId: string;
  /**
   * Every GUID candidate iMessage surfaced for the tapback target. iMessage
   * `reaction.targetGuids` contains both the normalized form (e.g. `abc-123`)
   * and the raw form (e.g. `p:0/abc-123`). The outbound binding may be
   * registered under either form depending on which the imsg bridge returned
   * from `send`, so the lookup must probe all of them.
   */
  messageIdCandidates: readonly string[];
  actorHandle: string;
  reactionKey: string;
  action: "added" | "removed";
};

function readApprovalReactionEvent(
  message: IMessagePayload,
  bodyText: string,
): IMessageApprovalReactionEvent | null {
  const reaction = resolveIMessageReactionContext(message, bodyText);
  if (!reaction) {
    return null;
  }
  const reactionKey = reaction.emoji.trim();
  const candidates = (reaction.targetGuids ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const primary = reaction.targetGuid?.trim() || candidates[0] || "";
  const messageIdCandidates = candidates.length > 0 ? candidates : primary ? [primary] : [];
  const actorHandle = normalizeIMessageHandle((message.sender ?? "").trim());
  if (!reactionKey || !primary || !actorHandle) {
    return null;
  }
  const conversation = buildIMessageApprovalConversationKeyForInbound({
    chatGuid: message.chat_guid,
    chatIdentifier: message.chat_identifier,
    chatId: message.chat_id,
    isGroup: message.is_group,
    actorHandle,
  });
  if (!normalizeConversationKey(conversation)) {
    return null;
  }
  return {
    conversation,
    messageId: primary,
    messageIdCandidates,
    actorHandle,
    reactionKey,
    action: reaction.action,
  };
}

export async function handleIMessageApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
  gatewayUrl?: string;
  gatewayRuntime?: IMessageApprovalGatewayRuntime;
  logVerboseMessage?: (message: string) => void;
}): Promise<IMessageApprovalReactionHandleResult> {
  const event = readApprovalReactionEvent(params.message, params.bodyText);
  if (!event) {
    return { handled: false, stopPolling: false };
  }
  // A removed tapback (user un-taps 👍 or switches to a different emoji) is
  // intentionally NOT a fresh resolve. We only want to clear the binding so
  // the next added-tapback resolves freshly. Falling through to `return false`
  // would surface the un-tap as a noisy reaction system event; instead we
  // own the event and stay quiet.
  if (event.action === "removed") {
    return { handled: false, stopPolling: false };
  }
  let target: IMessageApprovalReactionResolution | null = null;
  let matchedMessageId: string | null = null;
  for (const candidate of event.messageIdCandidates) {
    target = await resolveIMessageApprovalReactionTargetWithPersistence({
      accountId: params.accountId,
      conversation: event.conversation,
      messageId: candidate,
      reactionKey: event.reactionKey,
    });
    if (target) {
      matchedMessageId = candidate;
      break;
    }
  }
  if (!target) {
    return { handled: false, stopPolling: false };
  }

  const approvers = getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId });
  if (approvers.length === 0) {
    params.logVerboseMessage?.(
      `imessage: approval reaction denied id=${target.approvalId}; reactions require explicit approvers`,
    );
    return { handled: true, stopPolling: false };
  }
  const auth = imessageApprovalAuth.authorizeActorAction({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: event.actorHandle,
    action: "approve",
    approvalKind: target.approvalKind,
  });
  if (!auth.authorized) {
    params.logVerboseMessage?.(
      `imessage: approval reaction denied id=${target.approvalId} sender=${event.actorHandle}`,
    );
    return { handled: true, stopPolling: false };
  }

  const resolveApprovalOverGateway = await loadResolveApprovalOverGateway();
  try {
    const result = await resolveApprovalOverGateway({
      cfg: params.cfg,
      approvalId: target.approvalId,
      approvalKind: target.approvalKind,
      decision: target.decision,
      channel: "imessage",
      accountId: params.accountId,
      senderId: event.actorHandle,
      gatewayUrl: params.gatewayUrl,
      ...(params.gatewayRuntime ? { gatewayRuntime: params.gatewayRuntime } : {}),
    });
    // Every terminal result clears the binding. Losing surfaces receive applied:false
    // without a new event, so retaining their controls would keep polling stale state.
    // Iterate every GUID candidate so prefixed/unprefixed forms are both cleared.
    for (const candidate of event.messageIdCandidates) {
      unregisterIMessageApprovalReactionTarget({
        accountId: params.accountId,
        conversation: event.conversation,
        messageId: candidate,
      });
    }
    const outcome = result.applied ? "resolved" : "already resolved";
    params.logVerboseMessage?.(
      `imessage: approval reaction ${outcome} id=${target.approvalId} sender=${event.actorHandle} ${formatCanonicalApprovalTerminalState(result.approval)} via messageId=${matchedMessageId ?? event.messageId}`,
    );
    return { handled: true, stopPolling: true, stopPollingReason: "resolved" };
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      for (const candidate of event.messageIdCandidates) {
        unregisterIMessageApprovalReactionTarget({
          accountId: params.accountId,
          conversation: event.conversation,
          messageId: candidate,
        });
      }
      params.logVerboseMessage?.(
        `imessage: approval reaction ignored for expired approval id=${target.approvalId} sender=${event.actorHandle}`,
      );
      return { handled: true, stopPolling: true, stopPollingReason: "not-found" };
    }
    // Surface non-NotFound errors at warn level so a gateway 5xx / network
    // outage / auth failure is visible without OPENCLAW_LOG_LEVEL=debug.
    try {
      getOptionalIMessageRuntime()
        ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-reactions" })
        .warn("approval reaction failed", {
          approvalId: target.approvalId,
          senderId: event.actorHandle,
          error: String(error),
        });
    } catch {
      // Logger surface is optional in tests; never let logging mask the error.
    }
    params.logVerboseMessage?.(
      `imessage: approval reaction failed id=${target.approvalId} sender=${event.actorHandle}: ${String(error)}`,
    );
    // A transient Gateway 5xx/network/auth error is not terminal: propagate it
    // so the durable ingress drain releases the claim and replays the reaction
    // under its retry policy, as the signal (#130134) and matrix (#129879)
    // owners do. Returning any result here would commit or drop the claim.
    throw error;
  }
}

export async function maybeResolveIMessageApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
  gatewayUrl?: string;
  gatewayRuntime?: IMessageApprovalGatewayRuntime;
  logVerboseMessage?: (message: string) => void;
}): Promise<boolean> {
  return (await handleIMessageApprovalReaction(params)).handled;
}

export function clearIMessageApprovalReactionTargetsForTest(): void {
  imessageApprovalReactionTargets.clearForTest();
  clearIMessageApprovalReactionPollTargetsForTest();
  loadResolveApprovalOverGateway.clear();
}
