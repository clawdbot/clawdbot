/**
 * Runs the fail-closed before_agent_run gate and persists blocked turns.
 */
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import {
  runAgentHarnessBeforeAgentRunHook,
  type AgentHarnessBeforeAgentRunBlock,
} from "../../harness/lifecycle-hook-helpers.js";
import type { AgentMessage } from "../../runtime/index.js";
import { log } from "../logger.js";
import { flushSessionManagerTranscript } from "./attempt-transcript-helpers.js";
import { sessionMessagesContainIdempotencyKey } from "./pre-persisted-user-turn.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;
type BeforeAgentRunHookRunner = Pick<HookRunner, "hasHooks" | "runBeforeAgentRun">;
type HookContext = Parameters<HookRunner["runBeforeAgentRun"]>[1];
type AttemptSessionManager = Parameters<typeof flushSessionManagerTranscript>[0];
type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

type BeforeAgentRunSession = {
  messages: AgentMessage[];
  agent: { state: { messages: AgentMessage[] } };
};

type BeforeAgentRunBlockOutcome = {
  blockedBy: string;
  promptError: Error;
};

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
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
}): Promise<BeforeAgentRunBlockOutcome | undefined> {
  if (!input.hookRunner?.hasHooks("before_agent_run")) {
    return undefined;
  }

  const persistBlockedBeforeAgentRun = async (
    block: AgentHarnessBeforeAgentRunBlock,
  ): Promise<void> => {
    if (
      sessionMessagesContainIdempotencyKey(
        input.activeSession.messages,
        block.blockedUserMessage.idempotencyKey,
      )
    ) {
      return;
    }
    try {
      await input.withOwnedTranscriptWrite(() => {
        input.sessionManager.appendMessage(
          block.blockedUserMessage as Parameters<typeof input.sessionManager.appendMessage>[0],
        );
        flushSessionManagerTranscript(input.sessionManager);
      });
      input.activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
        input.sessionManager.buildSessionContext().messages,
      );
    } catch (err) {
      log.warn(
        `before_agent_run block: failed to persist redacted user message: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
    }
  };

  const block = await runAgentHarnessBeforeAgentRunHook({
    runId: input.attempt.runId,
    event: {
      prompt: input.modelPrompt,
      systemPrompt: input.systemPrompt,
      messages: input.hookMessages,
      channelId: input.hookContext.channelId,
      accountId: input.attempt.agentAccountId ?? undefined,
      senderId: input.attempt.senderId ?? undefined,
      senderIsOwner: input.attempt.senderIsOwner ?? undefined,
    },
    ctx: input.hookContext,
    hookRunner: input.hookRunner,
  });
  if (!block) {
    return undefined;
  }
  await persistBlockedBeforeAgentRun(block);
  return { blockedBy: block.blockedBy, promptError: new Error(block.message) };
}
