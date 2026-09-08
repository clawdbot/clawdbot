import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { handleEmbeddedAttemptPromptError } from "./attempt-prompt-submit.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt-sessions-yield.js";

registerAgentSessionLoopTestLifecycle();

describe("sessions_yield transcript handoff", () => {
  it.each([null, "Continue after the child completes"])(
    "leaves yielded history ready for the next queued turn (context=%s)",
    async (yieldMessage) => {
      await withOpenClawTestState({ label: "yield-projection-handoff" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "yielded-session",
          sessionKey: "agent:main:yielded-session",
          storePath: state.statePath("sessions.json"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const manager = SessionManager.open(target, state.workspaceDir);
        const { session } = await createTestSession({ sessionManager: manager });
        // Large histories rebuild asynchronously after yield cleanup replaces them.
        for (let index = 0; index < 4_001; index += 1) {
          manager.appendCustomEntry("fixture-history", { index });
        }
        const user: AgentMessage = { role: "user", content: "Continue the task", timestamp: 1 };
        const toolResult: AgentMessage = {
          role: "toolResult",
          toolCallId: "yield-call",
          toolName: "sessions_yield",
          content: [{ type: "text", text: "yielded" }],
          isError: false,
          timestamp: 2,
        };
        const aborted = createAssistant(testModel, [], "aborted");
        manager.appendMessage(user);
        manager.appendMessage(toolResult);
        manager.appendMessage(aborted);
        // A live yield still has the synthetic abort that normal history loading omits.
        session.agent.state.messages = [user, toolResult, aborted];
        try {
          await handleEmbeddedAttemptPromptError({
            activeSession: session,
            attempt: { runId: "yielding-run", sessionId: target.sessionId },
            error: new Error("aborted", { cause: SESSIONS_YIELD_ABORT_REASON }),
            handleMidTurnPrecheckRequest: vi.fn(),
            markYieldAborted: vi.fn(),
            releaseLeasedSteering: vi.fn(),
            withOwnedTranscriptWrite: async (operation) => await operation(),
            yieldAbortSettled: null,
            yieldDetected: true,
            yieldMessage,
          });
          // Reopen exactly as the next queued attempt does, with no unrelated await.
          const reopened = SessionManager.open(target, state.workspaceDir, {
            maxBytes: 4096,
            maxEvents: 20,
          });
          const messages = reopened.buildSessionContext().messages;
          expect(messages.map((message) => message.role)).toEqual(
            yieldMessage ? ["user", "toolResult", "custom"] : ["user", "toolResult"],
          );
          expect(messages[0]).toMatchObject({ content: "Continue the task" });
        } finally {
          session.dispose();
        }
      });
    },
  );
});
