/**
 * sessions_send agent-to-agent reply flow.
 *
 * Runs bounded ping-pong delivery, waits for target replies, and suppresses control-token messages.
 */
import crypto from "node:crypto";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AgentWaitResult,
  type AssistantReplySnapshot,
  hasUpdatedAssistantReplySnapshot,
  isRecoverableAgentWaitError,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
} from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
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

type GatewayCaller = <T = unknown>(opts: CallGatewayOptions) => Promise<T>;

const defaultSessionsSendA2ADeps = {
  callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
    const { callGateway } = await import("../../gateway/call.js");
    return callGateway<T>(opts);
  },
};

let sessionsSendA2ADeps: {
  callGateway: GatewayCaller;
} = defaultSessionsSendA2ADeps;

function isDeliveryFailureWait(wait: AgentWaitResult): boolean {
  return (
    (wait.status === "error" && !isRecoverableAgentWaitError(wait.error)) ||
    (wait.status === "timeout" && wait.pendingError === true)
  );
}

async function deliverAnnounceReply(params: {
  announceTarget: AnnounceTarget;
  message: string;
  runContextId: string;
}) {
  const message = params.message.trim();
  if (!message) {
    return;
  }
  try {
    await sessionsSendA2ADeps.callGateway({
      method: "send",
      params: {
        to: params.announceTarget.to,
        message,
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
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  baseline?: AssistantReplySnapshot;
  roundOneReply?: string;
  waitRunId?: string;
  notifyRequesterOnWaitFailure?: boolean;
}) {
  const runContextId = params.waitRunId ?? "unknown";
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const wait = await waitForAgentRun({
        runId: params.waitRunId,
        timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
        callGateway: sessionsSendA2ADeps.callGateway,
      });
      if (wait.status === "ok") {
        const latestSnapshot = await readLatestAssistantReplySnapshot({
          sessionKey: params.targetSessionKey,
          stopAtTranscriptArtifact: true,
          callGateway: sessionsSendA2ADeps.callGateway,
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
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    // A same-session send is a human-facing source-channel reply, not a true
    // agent-to-agent announcement. Asking the same session to decide whether to
    // announce can re-run the same prompt and duplicate source-reply side effects.
    const sameSessionSourceReply =
      params.requesterSessionKey && params.requesterSessionKey === params.targetSessionKey;
    const canDirectDeliverSameSessionReply =
      announceTarget &&
      (!params.requesterChannel || params.requesterChannel === announceTarget.channel);
    if (sameSessionSourceReply && canDirectDeliverSameSessionReply) {
      if (params.waitRunId && !params.roundOneReply && !params.baseline) {
        return;
      }
      await deliverAnnounceReply({
        announceTarget,
        message: latestReply,
        runContextId,
      });
      return;
    }
    if (sameSessionSourceReply && !announceTarget) {
      return;
    }

    if (
      params.maxPingPongTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";
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
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: resolveNestedAgentLaneForSession(currentSessionKey),
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
        });
        if (!replyText || isReplySkip(replyText) || isNonDeliverableSessionsReply(replyText)) {
          break;
        }
        latestReply = replyText;
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
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
      sessionKey: params.targetSessionKey,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: resolveNestedAgentLaneForSession(params.targetSessionKey),
      transcriptMessage: "",
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
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
        message: announceReply,
        runContextId,
      });
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}

export const testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
  },
};
export { testing as __testing };
