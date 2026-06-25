/**
 * Runs the fail-closed before_agent_run gate and persists blocked turns.
 */
import { resolveBlockMessage } from "../../../plugins/hook-decision-types.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { AgentMessage } from "../../runtime/index.js";
import { log } from "../logger.js";
import { cloneHookMessages } from "./attempt-hook-messages.js";
import { flushSessionManagerTranscript } from "./attempt-transcript-helpers.js";
import { sessionMessagesContainIdempotencyKey } from "./pre-persisted-user-turn.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;
type BeforeAgentRunHookRunner = Pick<HookRunner, "hasHooks" | "runBeforeAgentRun">;
type HookContext = Parameters<HookRunner["runBeforeAgentRun"]>[1];
type AttemptSessionManager = Parameters<typeof flushSessionManagerTranscript>[0];
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

type BeforeAgentRunSession = {
  messages: AgentMessage[];
  agent: { state: { messages: AgentMessage[] } };
};

export type BeforeAgentRunOutcome =
  | { kind: "block"; blockedBy: string; promptError: Error }
  | { kind: "transform"; prompt: string };

export async function runEmbeddedAttemptBeforeAgentRun(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "agentAccountId" | "runId" | "senderId" | "senderIsOwner"
  >;
  activeSession: BeforeAgentRunSession;
  hookContext: HookContext;
  hookMessages: AgentMessage[];
  hookRunner: BeforeAgentRunHookRunner | null;
  modelPrompt: string;
  sessionManager: AttemptSessionManager;
  systemPrompt: string;
  withOwnedSessionWriteLock: WithOwnedSessionWriteLock;
}): Promise<BeforeAgentRunOutcome | undefined> {
  if (!input.hookRunner?.hasHooks("before_agent_run")) {
    return undefined;
  }

  const persistBlockedBeforeAgentRun = async (block: {
    message: string;
    pluginId: string;
  }): Promise<boolean> => {
    const idempotencyKey = `hook-block:before_agent_run:user:${input.attempt.runId}`;
    if (sessionMessagesContainIdempotencyKey(input.activeSession.messages, idempotencyKey)) {
      return true;
    }
    const nowMs = Date.now();
    const redactedUserMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: block.message }],
      timestamp: nowMs,
      idempotencyKey,
      __openclaw: {
        beforeAgentRunBlocked: {
          blockedBy: block.pluginId,
          blockedAt: nowMs,
        },
      },
    };
    try {
      await input.withOwnedSessionWriteLock(() => {
        input.sessionManager.appendMessage(
          redactedUserMessage as Parameters<typeof input.sessionManager.appendMessage>[0],
        );
        flushSessionManagerTranscript(input.sessionManager);
      });
      input.activeSession.agent.state.messages =
        input.sessionManager.buildSessionContext().messages;
      return true;
    } catch (err) {
      log.warn(
        `before_agent_run block: failed to persist redacted user message: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
      return false;
    }
  };

  let beforeRunResult: Awaited<ReturnType<HookRunner["runBeforeAgentRun"]>> | undefined;
  try {
    beforeRunResult = await input.hookRunner.runBeforeAgentRun(
      {
        prompt: input.modelPrompt,
        systemPrompt: input.systemPrompt,
        messages: cloneHookMessages(input.hookMessages),
        channelId: input.hookContext.channelId,
        accountId: input.attempt.agentAccountId ?? undefined,
        senderId: input.attempt.senderId ?? undefined,
        senderIsOwner: input.attempt.senderIsOwner ?? undefined,
      },
      input.hookContext,
    );
  } catch {
    log.warn("before_agent_run hook failed; blocking request");
    const blockedBy = "before_agent_run";
    const message = resolveBlockMessage(
      { outcome: "block", reason: "before_agent_run hook failed" },
      { blockedBy },
    );
    await persistBlockedBeforeAgentRun({ message, pluginId: blockedBy });
    return { kind: "block", blockedBy, promptError: new Error(message) };
  }

  const beforeRunDecision = beforeRunResult?.decision;
  if (beforeRunDecision?.outcome === "transform") {
    return { kind: "transform", prompt: beforeRunDecision.prompt };
  }
  if (beforeRunDecision?.outcome !== "block") {
    return undefined;
  }
  const blockedBy = beforeRunResult?.pluginId ?? "unknown";
  const message = resolveBlockMessage(beforeRunDecision, { blockedBy });
  log.warn(`before_agent_run hook blocked by ${blockedBy}`);
  await persistBlockedBeforeAgentRun({ message, pluginId: blockedBy });
  return { kind: "block", blockedBy, promptError: new Error(message) };
}
