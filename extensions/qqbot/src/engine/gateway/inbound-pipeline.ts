/**
 * Inbound pipeline — compose stages into a single
 * {@link buildInboundContext} call.
 *
 * The pipeline stays intentionally thin: all real logic lives in
 * `./stages/*`. Reading this file top-to-bottom should be enough to
 * understand the full inbound path.
 *
 * Stage order:
 *   1. access      — route + access control (early return on block)
 *   2. attachments — download + STT + image metadata
 *   3. typing      — start the typing indicator (awaited before refIdx write)
 *   4. content     — parseFaceTags + voice text + attachment info + mention cleanup
 *   5. quote       — resolve `refMsgIdx` three ways
 *   6. refIdx      — cache the current message so future quotes work
 *   7. group gate  — @mention / ignoreOther / activation / command bypass
 *                    (early return on skip, history already recorded)
 *   8. envelope    — body / quotePart / dynamicCtx
 *   9. assembly    — userMessage + agentBody (with pending-history prefix)
 *  10. system      — final group system prompt composition
 *  11. classify    — media classification (local vs remote; dedup voice)
 *
 * Returns a fully populated {@link InboundContext}. The gateway handler
 * then branches on `blocked` / `skipped` to decide whether to dispatch
 * outbound.
 */

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
  resolveCommandAuthorized,
  resolveQuote,
  runAccessStage,
  runGroupGateStage,
  writeRefIndex,
} from "./stages/index.js";

/**
 * Process a raw queued message through the full inbound pipeline.
 *
 * Returns an {@link InboundContext} with `blocked` / `skipped` set when
 * the message should not reach the AI dispatcher.
 */
export async function buildInboundContext(
  event: QueuedMessage,
  deps: InboundPipelineDeps,
): Promise<InboundContext> {
  const { account, log } = deps;

  // ---- 1. Access ----
  const accessResult = runAccessStage(event, deps);
  if (accessResult.kind === "block") {
    return accessResult.context;
  }
  const { isGroupChat, peerId, qualifiedTarget, fromAddress, route, access } = accessResult;

  // ---- 2. Typing indicator (async; awaited before refIdx write) ----
  const typingPromise = deps.startTyping(event);

  // ---- 3. Attachments ----
  const processed = await processAttachments(event.attachments, {
    accountId: account.accountId,
    cfg: deps.cfg,
    audioConvert: deps.adapters.audioConvert,
    log,
  });

  // ---- 4. Content ----
  const { parsedContent, userContent } = buildUserContent({
    event,
    attachmentInfo: processed.attachmentInfo,
    voiceTranscripts: processed.voiceTranscripts,
  });

  // ---- 5. Quote ----
  const replyTo = await resolveQuote(event, deps);

  // ---- 6. RefIdx ----
  const typingResult = await typingPromise;
  writeRefIndex({
    event,
    parsedContent,
    processed,
    inputNotifyRefIdx: typingResult.refIdx,
  });

  // ---- 7. Group gate ----
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

  // ---- 8. Envelope ----
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

  // ---- 9. Assembly ----
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

  // ---- 10. System prompt ----
  const systemPrompts: string[] = [];
  if (account.systemPrompt) {
    systemPrompts.push(account.systemPrompt);
  }
  const accountSystemInstruction = systemPrompts.length > 0 ? systemPrompts.join("\n") : "";
  const groupSystemPrompt = buildGroupSystemPrompt(accountSystemInstruction, groupInfo);

  // ---- 11. Authorization ----
  const commandAuthorized = resolveCommandAuthorized(access);

  return {
    event,
    route,
    isGroupChat,
    peerId,
    qualifiedTarget,
    fromAddress,
    parsedContent,
    userContent,
    quotePart,
    dynamicCtx,
    userMessage,
    agentBody,
    body,
    systemPrompts,
    groupSystemPrompt,
    attachments: processed,
    localMediaPaths: media.localMediaPaths,
    localMediaTypes: media.localMediaTypes,
    remoteMediaUrls: media.remoteMediaUrls,
    remoteMediaTypes: media.remoteMediaTypes,
    uniqueVoicePaths: media.uniqueVoicePaths,
    uniqueVoiceUrls: media.uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts: media.uniqueVoiceAsrReferTexts,
    voiceMediaTypes: media.voiceMediaTypes,
    hasAsrReferFallback: media.hasAsrReferFallback,
    voiceTranscriptSources: media.voiceTranscriptSources,
    replyTo,
    commandAuthorized,
    group: groupInfo,
    blocked: false,
    skipped: false,
    accessDecision: access.decision,
    typing: { keepAlive: typingResult.keepAlive },
    inputNotifyRefIdx: typingResult.refIdx,
  };
}

// ============ Public history-clear helper ============

/**
 * Clear a group's pending history buffer. Exposed so the gateway can
 * call it in its `finally` block after a reply attempt.
 */
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
