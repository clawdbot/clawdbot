import type { HistoryPort } from "../adapter/history.port.js";
import type { HistoryEntry } from "../group/history.js";
import { processAttachments } from "./inbound-attachments.js";
import type { InboundContext, InboundPipelineDeps } from "./inbound-context.js";
import type { QueuedMessage } from "./message-queue.js";
import {
  buildAgentBody,
  buildBody,
  buildDynamicCtx,
  buildGroupSystemPrompt,
  buildQuotePart,
  buildSkippedInboundContext,
  buildUserContent,
  buildUserMessage,
  classifyMedia,
  resolveQuote,
  runAccessStage,
  runGroupGateStage,
  writeRefIndex,
} from "./stages/index.js";

export async function buildInboundContext(
  event: QueuedMessage,
  deps: InboundPipelineDeps,
): Promise<InboundContext> {
  const { account, log } = deps;

  const accessResult = await runAccessStage(event, deps);
  if (accessResult.kind === "block") {
    return accessResult.context;
  }
  const { isGroupChat, peerId, qualifiedTarget, fromAddress, route, access } = accessResult;

  const typingPromise = deps.startTyping(event);

  const processed = await processAttachments(event.attachments, {
    accountId: account.accountId,
    cfg: deps.cfg,
    audioConvert: deps.adapters.audioConvert,
    log,
  });

  const { parsedContent, userContent } = buildUserContent({
    event,
    attachmentInfo: processed.attachmentInfo,
    voiceTranscripts: processed.voiceTranscripts,
  });

  const replyTo = await resolveQuote(event, deps);

  const typingResult = await typingPromise;
  writeRefIndex({
    event,
    parsedContent,
    processed,
    inputNotifyRefIdx: typingResult.refIdx,
  });

  let groupInfo: InboundContext["group"];
  if (event.type === "group" && event.groupOpenid) {
    const gateOutcome = runGroupGateStage({
      event,
      deps,
      accountId: account.accountId,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      userContent,
      processedAttachments: processed,
      access,
    });

    if (gateOutcome.kind === "skip") {
      typingResult.keepAlive?.stop();
      return buildSkippedInboundContext({
        event,
        route,
        isGroupChat: true,
        peerId,
        qualifiedTarget,
        fromAddress,
        group: gateOutcome.groupInfo,
        skipReason: gateOutcome.skipReason,
        access,
        typing: { keepAlive: typingResult.keepAlive },
        inputNotifyRefIdx: typingResult.refIdx,
      });
    }
    groupInfo = gateOutcome.groupInfo;
  }

  const body = buildBody({
    event,
    deps,
    userContent,
    isGroupChat,
    imageUrls: processed.imageUrls,
  });
  const quotePart = buildQuotePart(replyTo);
  const media = classifyMedia(processed);
  const dynamicCtx = buildDynamicCtx({
    imageUrls: processed.imageUrls,
    uniqueVoicePaths: media.uniqueVoicePaths,
    uniqueVoiceUrls: media.uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts: media.uniqueVoiceAsrReferTexts,
  });

  const userMessage = buildUserMessage({
    event,
    userContent,
    quotePart,
    isGroupChat,
    groupInfo,
  });
  const agentBody = buildAgentBody({
    event,
    userContent,
    userMessage,
    dynamicCtx,
    isGroupChat,
    groupInfo,
    deps,
  });

  const accountSystemInstruction = account.systemPrompt ?? "";
  const groupSystemPrompt = buildGroupSystemPrompt(accountSystemInstruction, groupInfo);

  return {
    event,
    route,
    isGroupChat,
    peerId,
    qualifiedTarget,
    fromAddress,
    agentBody,
    body,
    groupSystemPrompt,
    localMediaPaths: media.localMediaPaths,
    localMediaTypes: media.localMediaTypes,
    remoteMediaUrls: media.remoteMediaUrls,
    uniqueVoicePaths: media.uniqueVoicePaths,
    uniqueVoiceUrls: media.uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts: media.uniqueVoiceAsrReferTexts,
    voiceMediaTypes: media.voiceMediaTypes,
    hasAsrReferFallback: media.hasAsrReferFallback,
    voiceTranscriptSources: media.voiceTranscriptSources,
    replyTo,
    commandAuthorized: access.commandAccess.authorized,
    group: groupInfo,
    blocked: false,
    skipped: false,
    accessDecision: access.senderAccess.decision,
    typing: { keepAlive: typingResult.keepAlive },
    inputNotifyRefIdx: typingResult.refIdx,
  };
}

export function clearGroupPendingHistory(params: {
  historyMap: Map<string, HistoryEntry[]> | undefined;
  groupOpenid: string | undefined;
  historyLimit: number;
  historyPort: HistoryPort;
}): void {
  if (!params.historyMap || !params.groupOpenid) {
    return;
  }
  params.historyPort.clearPendingHistory({
    historyMap: params.historyMap,
    historyKey: params.groupOpenid,
    limit: params.historyLimit,
  });
}
