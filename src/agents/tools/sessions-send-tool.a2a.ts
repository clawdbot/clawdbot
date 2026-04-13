import crypto from "node:crypto";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, waitForAgentRun } from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
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

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
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
        primaryReply = await readLatestAssistantReply({
          sessionKey: params.targetSessionKey,
        });
        latestReply = primaryReply;
      }
    }
    if (!latestReply) {
      return;
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

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
          lane: AGENT_LANE_NESTED,
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
        });
        if (!replyText || isReplySkip(replyText)) {
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
      lane: AGENT_LANE_NESTED,
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
    });
    if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
      try {
        await sessionsSendA2ADeps.callGateway({
          method: "send",
          params: {
            to: announceTarget.to,
            message: announceReply.trim(),
            channel: announceTarget.channel,
            accountId: announceTarget.accountId,
            threadId: announceTarget.threadId,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
      } catch (err) {
        log.warn("sessions_send announce delivery failed", {
          runId: runContextId,
          channel: announceTarget.channel,
          to: announceTarget.to,
          error: formatErrorMessage(err),
        });
      }
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
  },
};
