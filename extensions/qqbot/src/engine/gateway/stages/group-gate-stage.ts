/**
 * Group-gate stage — for `type === "group"` inbound events, decide
 * whether the message should pass to AI dispatch or be intercepted.
 *
 * Three possible outcomes:
 *   - `{ kind: "pass", groupInfo }` — continue the pipeline
 *   - `{ kind: "skip", groupInfo, skipReason }` — buffered to history
 *     (if applicable) and short-circuit
 *   - No group info at all — returned when the event isn't a group event
 *     (caller should treat as a straight pass-through)
 *
 * Consolidates the control-command auth check, session-store
 * activation override, mention detection, and the unified
 * {@link resolveGroupMessageGate} call. Delegates all pure logic to
 * existing `engine/group/*` modules so this stage remains a thin
 * orchestrator.
 */

import { createQQBotSenderMatcher, normalizeQQBotAllowFrom } from "../../access/index.js";
import { DEFAULT_GROUP_PROMPT, resolveGroupSettings } from "../../config/group.js";
import { resolveGroupActivation } from "../../group/activation.js";
import { toAttachmentSummaries, type HistoryEntry } from "../../group/history.js";
import { detectWasMentioned, hasAnyMention, resolveImplicitMention } from "../../group/mention.js";
import { getRefIndex } from "../../ref/store.js";
import type { InboundGroupInfo, InboundPipelineDeps } from "../inbound-context.js";
import { isMergedTurn, type QueuedMessage } from "../message-queue.js";

// ─────────────────────────── Types ───────────────────────────

interface GroupGatePass {
  kind: "pass";
  groupInfo: InboundGroupInfo;
}

interface GroupGateSkip {
  kind: "skip";
  groupInfo: InboundGroupInfo;
  skipReason: NonNullable<import("../inbound-context.js").InboundContext["skipReason"]>;
}

type GroupGateStageResult = GroupGatePass | GroupGateSkip;

interface GroupGateStageInput {
  event: QueuedMessage;
  deps: InboundPipelineDeps;
  accountId: string;
  agentId?: string;
  sessionKey: string;
  /** User-visible content (post-emoji-parse, post-mention-strip). */
  userContent: string;
  /** Already-processed attachments (downloaded). Available for history recording. */
  processedAttachments?: import("../inbound-attachments.js").ProcessedAttachments;
}

// ─────────────────────────── Stage ───────────────────────────

/**
 * Run the group-gate stage.
 *
 * Precondition: `event.type === "group"` && `event.groupOpenid` is set.
 * The caller (pipeline) enforces this; the stage doesn't re-check.
 *
 * On `skip` outcomes the stage records the message into the group's
 * history buffer when the skip reason is one that should preserve
 * context (drop / skip_no_mention), then returns. `block` skip
 * reasons do NOT write history — they are silent rejects.
 */
export function runGroupGateStage(input: GroupGateStageInput): GroupGateStageResult {
  const { event, deps, accountId, agentId, sessionKey, userContent, processedAttachments } = input;
  const groupOpenid = event.groupOpenid!;
  const cfg = (deps.cfg ?? {}) as Record<string, unknown>;

  // ---- 1. One-pass config resolution ----
  const settings = resolveGroupSettings({ cfg, groupOpenid, accountId, agentId });
  const { historyLimit, requireMention, ignoreOtherMentions } = settings.config;
  const behaviorPrompt = settings.config.prompt ?? DEFAULT_GROUP_PROMPT;
  const groupName = settings.name;

  // ---- 2. Mention detection (QQ-specific) ----
  const explicitWasMentioned = detectWasMentioned({
    eventType: event.eventType,
    mentions: event.mentions as never,
    content: event.content,
    mentionPatterns: settings.mentionPatterns,
  });
  const anyMention = hasAnyMention({
    mentions: event.mentions as never,
    content: event.content,
  });
  const implicitMention = resolveImplicitMention({
    refMsgIdx: event.refMsgIdx,
    getRefEntry: (idx) => getRefIndex(idx) ?? null,
  });

  // ---- 3. Activation mode (session store > cfg) ----
  const activation = resolveGroupActivation({
    cfg,
    agentId: agentId ?? "default",
    sessionKey,
    configRequireMention: requireMention,
    sessionStoreReader: deps.sessionStoreReader,
  });

  // ---- 4. Command authorization (for bypass) ----
  const content = (event.content ?? "").trim();
  const isControlCommand = Boolean(deps.isControlCommand?.(content));
  const commandAuthorized =
    deps.allowTextCommands !== false && isSenderAllowedForCommands(event.senderId, deps);

  // ---- 5. Gate evaluation ----
  // Layer 1 (ignoreOtherMentions) is QQ-specific and handled by
  // resolveGateWithPort. Layers 2+3 delegate to the SDK adapter.
  const gate = resolveGateWithPort({
    mentionGatePort: deps.adapters.mentionGate,
    ignoreOtherMentions,
    hasAnyMention: anyMention,
    wasMentioned: explicitWasMentioned,
    implicitMention,
    allowTextCommands: deps.allowTextCommands !== false,
    isControlCommand,
    commandAuthorized,
    requireMention: activation === "mention",
  });

  // ---- 6. Build InboundGroupInfo (shared by pass / skip paths) ----
  const introHint = deps.resolveGroupIntroHint?.({
    cfg,
    accountId,
    groupId: groupOpenid,
  });
  const senderLabel = event.senderName ? `${event.senderName} (${event.senderId})` : event.senderId;

  const groupInfo: InboundGroupInfo = {
    gate,
    activation,
    historyLimit,
    isMerged: isMergedTurn(event),
    mergedMessages: event.merge?.messages,
    display: {
      groupName,
      senderLabel,
      introHint,
      behaviorPrompt,
    },
  };

  // ---- 7. Decide pass vs skip ----
  if (gate.action === "pass") {
    return { kind: "pass", groupInfo };
  }

  // Skip path: record history for drop / skip_no_mention, silent for block.
  if (gate.action === "drop_other_mention" || gate.action === "skip_no_mention") {
    recordGroupHistory({
      historyMap: deps.groupHistories,
      groupOpenid,
      historyLimit,
      event,
      userContent,
      historyPort: deps.adapters.history,
      localPaths: processedAttachments?.attachmentLocalPaths,
    });
  }

  return { kind: "skip", groupInfo, skipReason: gate.action };
}

// ─────────────────────────── Internal helpers ───────────────────────────

import type { HistoryPort } from "../../adapter/history.port.js";
import type { MentionGatePort } from "../../adapter/mention-gate.port.js";
import type { GroupMessageGateResult } from "../../group/message-gating.js";

/**
 * Resolve the gate using the SDK MentionGatePort adapter.
 *
 * Layer 1 (ignoreOtherMentions) is QQ-specific and handled here.
 * Layers 2+3 delegate to the SDK's `resolveInboundMentionDecision`.
 */
function resolveGateWithPort(params: {
  mentionGatePort: MentionGatePort;
  ignoreOtherMentions: boolean;
  hasAnyMention: boolean;
  wasMentioned: boolean;
  implicitMention: boolean;
  allowTextCommands: boolean;
  isControlCommand: boolean;
  commandAuthorized: boolean;
  requireMention: boolean;
}): GroupMessageGateResult {
  // Layer 1: QQ-specific ignoreOtherMentions
  if (
    params.ignoreOtherMentions &&
    params.hasAnyMention &&
    !params.wasMentioned &&
    !params.implicitMention
  ) {
    return {
      action: "drop_other_mention",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
    };
  }

  // Layer 2+3: delegate to SDK mention gate (includes command bypass)
  const decision = params.mentionGatePort.resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      wasMentioned: params.wasMentioned,
      hasAnyMention: params.hasAnyMention,
      implicitMentionKinds: params.implicitMention ? ["reply_to_bot"] : [],
    },
    policy: {
      isGroup: true,
      requireMention: params.requireMention,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.isControlCommand,
      commandAuthorized: params.commandAuthorized,
    },
  });

  // Map SDK's shouldBlock (unauthorized command) to our action
  if (params.allowTextCommands && params.isControlCommand && !params.commandAuthorized) {
    return {
      action: "block_unauthorized_command",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
    };
  }

  if (decision.shouldSkip) {
    return {
      action: "skip_no_mention",
      effectiveWasMentioned: decision.effectiveWasMentioned,
      shouldBypassMention: decision.shouldBypassMention,
    };
  }

  return {
    action: "pass",
    effectiveWasMentioned: decision.effectiveWasMentioned,
    shouldBypassMention: decision.shouldBypassMention,
  };
}

/**
 * Test whether the sender is on the DM `allowFrom` list.
 */
function isSenderAllowedForCommands(senderId: string, deps: InboundPipelineDeps): boolean {
  const raw = deps.account.config?.allowFrom;
  if (!Array.isArray(raw) || raw.length === 0) {
    return true;
  }
  const normalized = normalizeQQBotAllowFrom(raw);
  return createQQBotSenderMatcher(senderId)(normalized);
}

function recordGroupHistory(params: {
  historyMap: Map<string, HistoryEntry[]> | undefined;
  groupOpenid: string;
  historyLimit: number;
  event: QueuedMessage;
  userContent: string;
  historyPort: HistoryPort;
  /** Local paths from processAttachments — enriches history with downloaded file paths. */
  localPaths?: Array<string | null>;
}): void {
  const { historyMap, groupOpenid, historyLimit, event, userContent, historyPort, localPaths } =
    params;
  if (!historyMap || historyLimit <= 0) {
    return;
  }

  const senderForHistory = event.senderName
    ? `${event.senderName} (${event.senderId})`
    : event.senderId;

  const entry: HistoryEntry = {
    sender: senderForHistory,
    body: userContent,
    timestamp: new Date(event.timestamp).getTime(),
    messageId: event.messageId,
    attachments: toAttachmentSummaries(event.attachments, localPaths),
  };

  historyPort.recordPendingHistoryEntry({
    historyMap,
    historyKey: groupOpenid,
    limit: historyLimit,
    entry,
  });
}
