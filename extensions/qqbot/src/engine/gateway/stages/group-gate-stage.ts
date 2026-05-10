import type { HistoryPort } from "../../adapter/history.port.js";
import type { QQBotInboundAccess } from "../../adapter/index.js";
import type { MentionGatePort } from "../../adapter/mention-gate.port.js";
import { DEFAULT_GROUP_PROMPT, resolveGroupSettings } from "../../config/group.js";
import { resolveGroupActivation } from "../../group/activation.js";
import { toAttachmentSummaries, type HistoryEntry } from "../../group/history.js";
import { detectWasMentioned, hasAnyMention, resolveImplicitMention } from "../../group/mention.js";
import type { GroupMessageGateResult } from "../../group/message-gating.js";
import { getRefIndex } from "../../ref/store.js";
import type { InboundContext, InboundGroupInfo, InboundPipelineDeps } from "../inbound-context.js";
import { isMergedTurn, type QueuedMessage } from "../message-queue.js";

interface GroupGatePass {
  kind: "pass";
  groupInfo: InboundGroupInfo;
}

interface GroupGateSkip {
  kind: "skip";
  groupInfo: InboundGroupInfo;
  skipReason: NonNullable<InboundContext["skipReason"]>;
}

type GroupGateStageResult = GroupGatePass | GroupGateSkip;

interface GroupGateStageInput {
  event: QueuedMessage;
  deps: InboundPipelineDeps;
  accountId: string;
  agentId?: string;
  sessionKey: string;
  userContent: string;
  processedAttachments?: import("../inbound-attachments.js").ProcessedAttachments;
  access: QQBotInboundAccess;
}

export function runGroupGateStage(input: GroupGateStageInput): GroupGateStageResult {
  const { event, deps, accountId, agentId, sessionKey, userContent, processedAttachments } = input;
  const groupOpenid = event.groupOpenid!;
  const cfg = (deps.cfg ?? {}) as Record<string, unknown>;

  const settings = resolveGroupSettings({ cfg, groupOpenid, accountId, agentId });
  const { historyLimit, requireMention, ignoreOtherMentions } = settings.config;
  const behaviorPrompt = settings.config.prompt ?? DEFAULT_GROUP_PROMPT;
  const groupName = settings.name;

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

  const activation = resolveGroupActivation({
    cfg,
    agentId: agentId ?? "default",
    sessionKey,
    configRequireMention: requireMention,
    sessionStoreReader: deps.sessionStoreReader,
  });

  const content = (event.content ?? "").trim();
  const isControlCommand = Boolean(deps.isControlCommand?.(content));
  const commandAuthorized =
    deps.allowTextCommands !== false && input.access.commandAccess.authorized;

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

  if (gate.action === "pass") {
    return { kind: "pass", groupInfo };
  }

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

function recordGroupHistory(params: {
  historyMap: Map<string, HistoryEntry[]> | undefined;
  groupOpenid: string;
  historyLimit: number;
  event: QueuedMessage;
  userContent: string;
  historyPort: HistoryPort;
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
