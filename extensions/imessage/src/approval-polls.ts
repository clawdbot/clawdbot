// Native Apple Messages poll bindings for approval prompts.
//
// Native polls replace tapback controls when the imsg bridge supports them.
// Poll delivery failures restore a bound tapback hint, so every prompt keeps
// one canonical interactive control path.
import {
  createApprovalReactionTargetStore,
  listApprovalReactionBindings,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";
import type { IMessageApprovalGatewayRuntime } from "./approval-gateway-types.js";
import {
  buildIMessageApprovalConversationKeyForInbound,
  enumerateApprovalTargetKeys,
  normalizeConversationKey,
  normalizeIMessageGuid,
  type IMessageApprovalConversationKey,
} from "./approval-target-keys.js";
import type { IMessagePayload, IMessagePoll } from "./monitor/types.js";
import { getOptionalIMessageRuntime } from "./runtime.js";
import { normalizeIMessageHandle } from "./targets.js";

const TARGET_NAMESPACE = "imessage.approval-polls";
const TOMBSTONE_NAMESPACE = "imessage.approval-poll-tombstones";
const MAX_ENTRIES = 1000;
const DEFAULT_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Messages has no close-poll API, so a resolved approval's balloon stays
 * tappable forever. Tombstones outlive the binding so late taps are swallowed
 * instead of reaching the agent as "Poll vote: ..." prose. Persisted, because a
 * gateway restart must not turn old polls back into chat noise.
 */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const APPROVAL_DECISIONS = new Set<ExecApprovalReplyDecision>([
  "allow-once",
  "allow-always",
  "deny",
]);

/** JSON-safe: option pairs stay an array so the persistent store round-trips. */
type IMessageApprovalPollTarget = {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
};

type IMessageApprovalPollTombstone = { approvalId: string };

const loadResolveApprovalOverGateway = createLazyRuntimeSurface(
  () => import("openclaw/plugin-sdk/approval-gateway-runtime"),
  (runtime) => runtime.resolveApprovalOverGateway,
);

const reportPersistentError = createPluginStateErrorReporter(
  getOptionalIMessageRuntime,
  "imessage",
  "approval-poll-state",
  "iMessage persistent approval poll state failed",
);

function readPersistedTarget(value: unknown): IMessageApprovalPollTarget | null {
  const target = value as Partial<IMessageApprovalPollTarget> | undefined;
  if (
    !target ||
    typeof target.approvalId !== "string" ||
    (target.approvalKind !== "exec" && target.approvalKind !== "plugin") ||
    !Array.isArray(target.optionDecisions)
  ) {
    return null;
  }
  const optionDecisions = target.optionDecisions.flatMap((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return [];
    }
    const [optionId, decision] = pair as [unknown, unknown];
    if (typeof optionId !== "string" || typeof decision !== "string") {
      return [];
    }
    return APPROVAL_DECISIONS.has(decision as ExecApprovalReplyDecision)
      ? [[optionId, decision as ExecApprovalReplyDecision] as const]
      : [];
  });
  return optionDecisions.length > 0
    ? { approvalId: target.approvalId, approvalKind: target.approvalKind, optionDecisions }
    : null;
}

const pollTargets = createApprovalReactionTargetStore<IMessageApprovalPollTarget>({
  namespace: TARGET_NAMESPACE,
  maxEntries: MAX_ENTRIES,
  defaultTtlMs: DEFAULT_TARGET_TTL_MS,
  openStore: (params) => getOptionalIMessageRuntime()?.state.openKeyedStore(params),
  logPersistentError: reportPersistentError,
  readPersistedTarget,
});

const pollTombstones = createApprovalReactionTargetStore<IMessageApprovalPollTombstone>({
  namespace: TOMBSTONE_NAMESPACE,
  maxEntries: MAX_ENTRIES,
  defaultTtlMs: TOMBSTONE_TTL_MS,
  openStore: (params) => getOptionalIMessageRuntime()?.state.openKeyedStore(params),
  logPersistentError: reportPersistentError,
  readPersistedTarget: (value) => {
    const approvalId = (value as { approvalId?: unknown } | undefined)?.approvalId;
    return typeof approvalId === "string" ? { approvalId } : null;
  },
});

/**
 * Poll option labels for an approval, in canonical decision order. Reuses the
 * tapback bindings so the two controls never disagree about which decisions
 * exist or what they are called.
 */
export function buildApprovalPollOptions(params: {
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): Array<{ decision: ExecApprovalReplyDecision; text: string }> {
  return listApprovalReactionBindings(params).map((binding) => ({
    decision: binding.decision,
    text: `${binding.emoji} ${binding.label}`,
  }));
}

/**
 * Match the option ids Messages returned back to decisions. Text only pairs the
 * response against what we asked for; the id is what a later vote is authorized
 * against, since option text in a vote payload is attacker-shaped.
 */
export function mapSentPollOptionsToDecisions(params: {
  requested: ReadonlyArray<{ decision: ExecApprovalReplyDecision; text: string }>;
  sent: ReadonlyArray<{ id: string; text: string }>;
}): Array<readonly [string, ExecApprovalReplyDecision]> {
  if (params.sent.length !== params.requested.length) {
    return [];
  }
  const byText = new Map(params.requested.map((option) => [option.text.trim(), option.decision]));
  const seenIds = new Set<string>();
  const seenDecisions = new Set<ExecApprovalReplyDecision>();
  const mapped: Array<readonly [string, ExecApprovalReplyDecision]> = [];
  for (const option of params.sent) {
    const id = option.id.trim();
    const decision = byText.get(option.text.trim());
    if (!id || !decision || seenIds.has(id) || seenDecisions.has(decision)) {
      return [];
    }
    seenIds.add(id);
    seenDecisions.add(decision);
    mapped.push([id, decision]);
  }
  return seenDecisions.size === params.requested.length ? mapped : [];
}

function registerIMessageApprovalPollTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid?: string;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
  expiresAtMs: number;
}): boolean {
  const accountId = params.accountId.trim();
  const approvalId = params.approvalId.trim();
  const expiresAtMs = asDateTimestampMs(params.expiresAtMs);
  const ttlMs = expiresAtMs === undefined ? undefined : expiresAtMs - Date.now();
  if (
    !accountId ||
    !approvalId ||
    params.optionDecisions.length === 0 ||
    ttlMs === undefined ||
    ttlMs <= 0
  ) {
    return false;
  }
  const keys = enumeratePollTargetKeys({
    accountId,
    conversation: params.conversation,
    pollGuid: params.pollGuid,
    optionIds: params.optionDecisions.map(([optionId]) => optionId),
  });
  if (keys.length === 0) {
    return false;
  }
  const target: IMessageApprovalPollTarget = {
    approvalId,
    approvalKind: params.approvalKind,
    optionDecisions: params.optionDecisions,
  };
  for (const key of keys) {
    pollTargets.register(key, target, { ttlMs });
    // The poll balloon outlives the approval and stays tappable. Keep its
    // ownership marker for the full balloon lifetime even if the live target
    // expires while the gateway is stopped.
    pollTombstones.register(key, { approvalId }, { ttlMs: TOMBSTONE_TTL_MS });
  }
  return true;
}

function unregisterIMessageApprovalPollTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid?: string;
  optionDecisions?: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
  approvalId?: string;
}): void {
  for (const key of enumeratePollTargetKeys({
    accountId: params.accountId,
    conversation: params.conversation,
    pollGuid: params.pollGuid,
    optionIds: params.optionDecisions?.map(([optionId]) => optionId),
  })) {
    pollTargets.delete(key);
    pollTombstones.register(
      key,
      { approvalId: params.approvalId ?? "" },
      { ttlMs: TOMBSTONE_TTL_MS },
    );
  }
}

/**
 * Consume votes for a poll that was created but could not be safely bound.
 * Messages has no reliable retract primitive for this balloon.
 */
function registerIMessageApprovalPollTombstone(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid?: string;
  optionIds?: readonly string[];
  approvalId: string;
}): boolean {
  const keys = enumeratePollTargetKeys({
    accountId: params.accountId,
    conversation: params.conversation,
    pollGuid: params.pollGuid,
    optionIds: params.optionIds,
  });
  if (keys.length === 0) {
    return false;
  }
  for (const key of keys) {
    pollTombstones.register(key, { approvalId: params.approvalId }, { ttlMs: TOMBSTONE_TTL_MS });
  }
  return true;
}

function enumeratePollTargetKeys(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid?: string;
  optionIds?: readonly string[];
}): string[] {
  const references = [
    ...(params.pollGuid?.trim() ? [`guid:${normalizeIMessageGuid(params.pollGuid)}`] : []),
    ...(params.optionIds ?? []).flatMap((optionId) => {
      const normalized = optionId.trim();
      return normalized ? [`option:${normalized}`] : [];
    }),
  ];
  return [
    ...new Set(
      references.flatMap((messageId) =>
        enumerateApprovalTargetKeys({
          accountId: params.accountId,
          conversation: params.conversation,
          messageId,
        }),
      ),
    ),
  ];
}

type ApprovalPollVoteEvent = {
  conversation: IMessageApprovalConversationKey;
  pollGuid: string;
  /** Transport row sender: the only authenticated identity on the event. */
  actorHandle: string;
  votes: Array<{
    optionId: string;
    participantKey: string;
    selected: boolean;
  }>;
  malformedVotes: boolean;
};

function readPollVoteEvent(message: IMessagePayload): ApprovalPollVoteEvent | null {
  const poll = message.poll as IMessagePoll | null | undefined;
  if (!poll || poll.kind !== "vote") {
    return null;
  }
  const pollGuid = normalizeIMessageGuid(
    (typeof poll.original_guid === "string" && poll.original_guid) ||
      (typeof poll.poll_guid === "string" && poll.poll_guid) ||
      "",
  );
  // chat.db authenticates received rows through sender. Released imsg fills an
  // empty sender from destination_caller_id before serialization, so reject a
  // received row when those identities are equal: its remote actor is
  // indistinguishable from the local-account fallback. Paired-device self-sends
  // may use destination_caller_id only when is_from_me is authoritative.
  const sender = normalizeIMessageHandle((message.sender ?? "").trim());
  const destinationCallerId = normalizeIMessageHandle((message.destination_caller_id ?? "").trim());
  const receivedSenderIsLocalFallback =
    message.is_from_me !== true &&
    Boolean(sender) &&
    Boolean(destinationCallerId) &&
    sender === destinationCallerId;
  const actorHandle =
    (receivedSenderIsLocalFallback ? "" : sender) ||
    (message.is_from_me === true ? destinationCallerId : "");
  if (!pollGuid || !actorHandle) {
    return null;
  }
  // `votes` is the complete decoded set. `vote` is only the first entry and is
  // retained by imsg for compatibility, so use it only when the full set is
  // absent (older bridge versions).
  const rawVotes = Array.isArray(poll.votes) ? poll.votes : poll.vote ? [poll.vote] : [];
  // The transport sender remains the authorization identity. participantHandle
  // may be a different active-account alias, but it can still prove whether a
  // complete multi-record set belongs to one participant or mixes users.
  let malformedVotes = false;
  const votes = rawVotes.flatMap((vote) => {
    if (!vote || typeof vote.option_id !== "string") {
      malformedVotes = true;
      return [];
    }
    const optionId = vote.option_id.trim();
    if (!optionId) {
      malformedVotes = true;
      return [];
    }
    return [
      {
        optionId,
        participantKey:
          typeof vote.participant === "string"
            ? normalizeIMessageHandle(vote.participant.trim().replace(/^[ep]:/iu, ""))
            : "",
        selected: vote.event_type === "selected",
      },
    ];
  });
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
    pollGuid,
    actorHandle,
    votes,
    malformedVotes,
  };
}

async function lookupPollTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid: string;
  optionIds: readonly string[];
}): Promise<IMessageApprovalPollTarget | null> {
  for (const key of enumeratePollTargetKeys({
    accountId: params.accountId,
    conversation: params.conversation,
    pollGuid: params.pollGuid,
    optionIds: params.optionIds,
  })) {
    const target = await pollTargets.lookup(key);
    if (target) {
      return target;
    }
  }
  return null;
}

async function hasTombstone(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid: string;
  optionIds: readonly string[];
}): Promise<boolean> {
  for (const key of enumeratePollTargetKeys({
    accountId: params.accountId,
    conversation: params.conversation,
    pollGuid: params.pollGuid,
    optionIds: params.optionIds,
  })) {
    if (await pollTombstones.lookup(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Outcomes for votes we own are logged at info, not verbose: an approval
 * decision is security-relevant, and diagnosing "the tap did nothing" must not
 * require re-running the gateway in debug.
 */
function info(message: string, fields: Record<string, unknown>): void {
  try {
    getOptionalIMessageRuntime()
      ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-polls" })
      .info(message, fields);
  } catch {
    // Logger surface is optional in tests; never let logging mask the outcome.
  }
}

function warn(message: string, fields: Record<string, unknown>): void {
  try {
    getOptionalIMessageRuntime()
      ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-polls" })
      .warn(message, fields);
  } catch {
    // Logger surface is optional in tests; never let logging mask the outcome.
  }
}

/**
 * Resolve a pending approval from an inbound native poll vote. Returns true when
 * the event belongs to an approval poll we own, so the monitor can stop it
 * before the ordinary dispatch pipeline renders it as prose.
 */
export async function maybeResolveIMessageApprovalPollVote(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  gatewayUrl?: string;
  gatewayRuntime?: IMessageApprovalGatewayRuntime;
}): Promise<boolean> {
  const event = readPollVoteEvent(params.message);
  if (!event) {
    return false;
  }
  const lookupKey = {
    accountId: params.accountId,
    conversation: event.conversation,
    pollGuid: event.pollGuid,
    optionIds: event.votes.map((vote) => vote.optionId),
  };
  const target = await lookupPollTarget(lookupKey);
  if (!target) {
    // Resolved/expired approval polls stay tappable; swallow late taps so they
    // do not reach the agent as chat messages.
    return await hasTombstone(lookupKey);
  }

  if (event.malformedVotes) {
    warn("approval poll vote ignored: malformed complete vote set", {
      approvalId: target.approvalId,
      actorHandle: event.actorHandle,
    });
    return true;
  }
  const directlyAttributedVotes = event.votes.filter(
    (vote) => vote.participantKey === event.actorHandle,
  );
  const participantKeys = new Set(event.votes.map((vote) => vote.participantKey).filter(Boolean));
  const actorVotes =
    directlyAttributedVotes.length > 0
      ? directlyAttributedVotes
      : event.votes.length === 1 || participantKeys.size === 1
        ? event.votes
        : [];
  if (actorVotes.length === 0) {
    warn("approval poll vote participants did not identify the transport actor", {
      approvalId: target.approvalId,
      actorHandle: event.actorHandle,
    });
    return true;
  }
  const selectedVotes = actorVotes.filter((vote) => vote.selected);
  // An un-vote is owned but never resolves: it must not emit "removed their
  // vote" prose while the approval is still pending.
  if (selectedVotes.length === 0) {
    info("approval poll deselect ignored; first selection decides", {
      approvalId: target.approvalId,
    });
    return true;
  }
  const selectedDecisions = selectedVotes.map((vote) => ({
    optionId: vote.optionId,
    decision: target.optionDecisions.find(([optionId]) => optionId === vote.optionId)?.[1],
  }));
  if (selectedDecisions.some((entry) => !entry.decision)) {
    warn("approval poll vote ignored: selected option not bound to a decision", {
      approvalId: target.approvalId,
      optionIds: selectedDecisions.map((entry) => entry.optionId),
    });
    return true;
  }
  const decisions = [...new Set(selectedDecisions.map((entry) => entry.decision))];
  if (decisions.length !== 1) {
    warn("approval poll vote ignored: ambiguous selected decisions", {
      approvalId: target.approvalId,
      decisions,
    });
    return true;
  }
  const decision = decisions[0];
  if (!decision) {
    return true;
  }
  if (getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0) {
    info("approval poll vote denied: no explicit approvers configured", {
      approvalId: target.approvalId,
    });
    return true;
  }
  const auth = imessageApprovalAuth.authorizeActorAction({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: event.actorHandle,
    action: "approve",
    approvalKind: target.approvalKind,
  });
  if (!auth.authorized) {
    info("approval poll vote denied: sender not an approver", {
      approvalId: target.approvalId,
      actorHandle: event.actorHandle,
    });
    return true;
  }

  const resolveApprovalOverGateway = await loadResolveApprovalOverGateway();
  try {
    const result = await resolveApprovalOverGateway({
      cfg: params.cfg,
      approvalId: target.approvalId,
      approvalKind: target.approvalKind,
      decision,
      channel: "imessage",
      accountId: params.accountId,
      senderId: event.actorHandle,
      gatewayUrl: params.gatewayUrl,
      ...(params.gatewayRuntime ? { gatewayRuntime: params.gatewayRuntime } : {}),
    });
    unregisterIMessageApprovalPollTarget({
      ...lookupKey,
      optionDecisions: target.optionDecisions,
      approvalId: target.approvalId,
    });
    info(`approval poll vote ${result.applied ? "resolved" : "already resolved"}`, {
      approvalId: target.approvalId,
      actorHandle: event.actorHandle,
      decision,
    });
    return true;
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      unregisterIMessageApprovalPollTarget({
        ...lookupKey,
        optionDecisions: target.optionDecisions,
        approvalId: target.approvalId,
      });
      info("approval poll vote ignored: approval already gone", {
        approvalId: target.approvalId,
      });
      return true;
    }
    // Keep the binding on a transient gateway/network failure so a retry can
    // still land; only terminal and not-found outcomes clear it.
    warn("approval poll vote failed", {
      approvalId: target.approvalId,
      senderId: event.actorHandle,
      error: String(error),
    });
    throw error;
  }
}

function clearIMessageApprovalPollTargetsForTest(): void {
  pollTargets.clearForTest();
  pollTombstones.clearForTest();
  loadResolveApprovalOverGateway.clear();
}

export const iMessageApprovalPollTargets = {
  register: registerIMessageApprovalPollTarget,
  unregister: unregisterIMessageApprovalPollTarget,
  registerTombstone: registerIMessageApprovalPollTombstone,
  clearForTest: clearIMessageApprovalPollTargetsForTest,
};
