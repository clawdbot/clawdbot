import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../llm/types.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
  serializeCacheTtlToolResultProjections,
} from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";

registerAgentSessionLoopTestLifecycle();
const sessionId = "projection-dispatch";
afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

describe("tool-result projection persistence at dispatch", () => {
  it("awaits the projection marker before every tool-loop dispatch", async () => {
    const { session: activeSession, sessionManager: manager } = await createTestSession();
    const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
    const projectionState = sessionPromptState.toolResults;
    const requests: Context["messages"][] = [];
    activeSession.agent.streamFn = (model, context) => {
      const marker = manager.getEntries().at(-1);
      expect(marker).toMatchObject({
        type: "custom",
        customType: "openclaw.cache-ttl",
        data: { frozenToolResults: expect.any(Array) },
      });
      expect(marker?.type === "custom" && marker.data).toEqual(
        serializeCacheTtlToolResultProjections(projectionState),
      );
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }]));
    };
    await submitEmbeddedAttemptPrompt({
      attempt: { sessionId },
      contextTokenBudget: 8_000,
      images: [],
      modelPrompt: "read files",
      onFinalPromptText: () => {},
      onSteeringAcknowledged: () => {},
      runtimeOnly: false,
      sessionPromptState,
      systemPrompt: "test prompt",
      toolResultAggregateMaxChars: 8_000,
      toolResultMaxChars: 4_000,
      toolResultPromptProjectionState: projectionState,
      trajectoryRecorder: null,
      transcriptLeafId: null,
      transcriptPrompt: "read files",
      activeSession,
      persistToolResultProjections: async () => {
        await Promise.resolve();
        manager.appendCustomEntry(
          "openclaw.cache-ttl",
          serializeCacheTtlToolResultProjections(projectionState),
        );
      },
      promptActiveSession: async () => {
        const messages: Context["messages"] = [];
        for (let index = 0; index < 3; index++) {
          messages.push(createAssistant(testModel, [{ type: "text", text: "read" }]), {
            role: "toolResult",
            toolCallId: `batch-${index}`,
            toolName: "read",
            content: [{ type: "text", text: "x".repeat(6_000) }],
            isError: false,
            timestamp: index,
          });
          await activeSession.agent.streamFn(testModel, { messages });
        }
      },
    });
    expect(requests).toHaveLength(3);
    expect(manager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(3);
    expect(requests[2]?.slice(0, 2)).toEqual(requests[0]);
  });
});
