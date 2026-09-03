/**
 * sessions_send agent-to-agent reply flow.
 *
 * Runs bounded ping-pong delivery, waits for target replies, and suppresses control-token messages.
 */
import crypto from "node:crypto";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AgentWaitResult,
  type AssistantReplySnapshot,
  hasUpdatedAssistantReplySnapshot,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
} from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  type AnnounceTarget,
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isNonDeliverableSessionsReply,
  isReplySkip,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

function sameOwnedSession(params: {
  leftKey: string | undefined;
  leftAgentId: string | undefined;
  rightKey: string;
  rightAgentId: string | undefined;
}): boolean {
  if (!params.leftKey || params.leftKey !== params.rightKey) {
    return false;
  }
  const leftAgentId = params.leftAgentId ?? parseAgentSessionKey(params.leftKey)?.agentId;
  const rightAgentId = params.rightAgentId ?? parseAgentSessionKey(params.rightKey)?.agentId;
  return Boolean(
    leftAgentId && rightAgentId && normalizeAgentId(leftAgentId) === normalizeAgentId(rightAgentId),
  );
}
function isDeliveryFailureWait(wait: AgentWaitResult): boolean {
  return (
    (wait.status === "error" && !wait.retryableTransportError) ||
    (wait.status === "timeout" && wait.pendingError === true)
  );
}

async function deliverAnnounceReply(params: {
  announceTarget: AnnounceTarget;
  callGateway: AgentToolGatewayRequestCaller;
  message: string;
  runContextId: string;
  targetSessionKey: string;
}) {
  // Gateway chooses media roots before its later outbound directive parse, so
  // project the media and its producing agent at the announcement boundary.
  const { text: message, mediaUrls, audioAsVoice } = splitMediaFromOutput(params.message.trim());
  if (!message && !mediaUrls?.length) {
    return;
  }
  const mediaAgentId = mediaUrls?.length
    ? parseAgentSessionKey(params.targetSessionKey)?.agentId
    : undefined;
  try {
    await params.callGateway({
      method: "send",
      params: {
        to: params.announceTarget.to,
        message,
        ...(mediaUrls?.length ? { mediaUrls } : {}),
        ...(mediaAgentId ? { agentId: mediaAgentId } : {}),
        ...(audioAsVoice ? { asVoice: true } : {}),
        channel: params.announceTarget.channel,
        accountId: params.announceTarget.accountId,
        threadId: params.announceTarget.threadId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send announce delivery failed", {
      runId: params.runContextId,
      channel: params.announceTarget.channel,
      to: params.announceTarget.to,
      error: formatErrorMessage(err),
    });
  }
}

export async function runSessionsSendA2AFlow(params: {
  callGateway?: AgentToolGatewayRequestCaller;
  targetSessionKey: string;
  targetAgentId?: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  requesterChannel?: string;
  baseline?: AssistantReplySnapshot;
  roundOneReply?: string;
  waitRunId?: string;
  notifyRequesterOnWaitFailure?: boolean;
}) {
  const runContextId = params.waitRunId ?? "unknown";
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const wait = await waitForAgentRun({
        runId: params.waitRunId,
        timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
        callGateway: gatewayCall,
      });
      if (wait.status === "ok") {
        const latestSnapshot = await readLatestAssistantReplySnapshot({
          sessionKey: params.targetSessionKey,
          agentId: params.targetAgentId,
          stopAtTranscriptArtifact: true,
          callGateway: gatewayCall,
        });
        primaryReply = hasUpdatedAssistantReplySnapshot(latestSnapshot, params.baseline)
          ? latestSnapshot.text
          : undefined;
        latestReply = primaryReply;
      } else {
        if (
          params.notifyRequesterOnWaitFailure === true &&
          params.requesterSessionKey &&
          isDeliveryFailureWait(wait)
        ) {
          const error =
            typeof wait.error === "string" && wait.error.trim() ? `: ${wait.error.trim()}` : "";
          await runAgentStep({
            agentId: params.requesterAgentId,
            sessionKey: params.requesterSessionKey,
            message:
              `sessions_send delivery to ${params.displayKey} failed${error}. ` +
              "The target may not have received the message; retry or report the failure instead of assuming delivery succeeded.",
            extraSystemPrompt:
              "A previous sessions_send delivery failed after it was accepted. Decide whether to retry, use another route, or report the failure. Do not assume the target received the message.",
            timeoutMs: params.announceTimeoutMs,
            lane: resolveNestedAgentLaneForSession(params.requesterSessionKey),
            sourceSessionKey: params.targetSessionKey,
            sourceTool: "sessions_send",
            callGateway: gatewayCall,
          });
        }
        return;
      }
    }
    if (!latestReply) {
      return;
    }
    if (isNonDeliverableSessionsReply(latestReply)) {
      return;
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
      callGateway: gatewayCall,
      agentId: params.targetAgentId,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    // A same-session send is a human-facing source-channel reply, not a true
    // agent-to-agent announcement. Asking the same session to decide whether to
    // announce can re-run the same prompt and duplicate source-reply side effects.
    const sameSessionSourceReply = sameOwnedSession({
      leftKey: params.requesterSessionKey,
      leftAgentId: params.requesterAgentId,
      rightKey: params.targetSessionKey,
      rightAgentId: params.targetAgentId,
    });
    const canDirectDeliverSameSessionReply =
      announceTarget &&
      (!params.requesterChannel || params.requesterChannel === announceTarget.channel);
    if (sameSessionSourceReply && canDirectDeliverSameSessionReply) {
      if (params.waitRunId && !params.roundOneReply && !params.baseline) {
        return;
      }
      await deliverAnnounceReply({
        announceTarget,
        callGateway: gatewayCall,
        message: latestReply,
        runContextId,
        targetSessionKey: params.targetSessionKey,
      });
      return;
    }
    if (sameSessionSourceReply && !announceTarget) {
      return;
    }

    if (params.maxPingPongTurns > 0 && params.requesterSessionKey && !sameSessionSourceReply) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let currentAgentId = params.requesterAgentId;
      let nextAgentId = params.targetAgentId;
      let currentRole: "requester" | "target" = "requester";
      let nextRole: "requester" | "target" = "target";
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: params.maxPingPongTurns,
        });
        const replyText = await runAgentStep({
          agentId: currentAgentId,
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: resolveNestedAgentLaneForSession(currentSessionKey),
          sourceAgentId: nextAgentId,
          sourceSessionKey: nextSessionKey,
          sourceChannel: nextRole === "requester" ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
          callGateway: gatewayCall,
        });
        if (!replyText || isReplySkip(replyText) || isNonDeliverableSessionsReply(replyText)) {
          break;
        }
        latestReply = replyText;
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
        const agentSwap = currentAgentId;
        currentAgentId = nextAgentId;
        nextAgentId = agentSwap;
        const roleSwap: "requester" | "target" = currentRole;
        currentRole = nextRole;
        nextRole = roleSwap;
      }
    }

    const announcePrompt = buildAgentToAgentAnnounceContext({
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      targetSessionKey: params.displayKey,
      targetChannel,
      originalMessage: params.message,
      roundOneReply: primaryReply,
      latestReply,
    });
    const announceReply = await runAgentStep({
      agentId: params.targetAgentId,
      sessionKey: params.targetSessionKey,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: resolveNestedAgentLaneForSession(params.targetSessionKey),
      transcriptMessage: "",
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
      callGateway: gatewayCall,
    });
    if (
      announceTarget &&
      announceReply &&
      announceReply.trim() &&
      !isAnnounceSkip(announceReply) &&
      !isNonDeliverableSessionsReply(announceReply)
    ) {
      await deliverAnnounceReply({
        announceTarget,
        callGateway: gatewayCall,
        message: announceReply,
        runContextId,
        targetSessionKey: params.targetSessionKey,
      });
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}
