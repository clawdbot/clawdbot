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
  createToolResultPromptProjectionState,
  getEmbeddedSessionPromptState,
  persistToolResultProjections,
  serializeCacheTtlToolResultProjections,
} from "../session-prompt-state.js";
import { restoreCacheTtlToolResultProjections } from "../tool-result-truncation.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";

registerAgentSessionLoopTestLifecycle();
const sessionId = "projection-dispatch";
afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

describe("tool-result projection persistence at dispatch", () => {
  it("restores only the latest active marker and retries changed snapshots after a failed write", async () => {
    const { sessionManager: manager } = await createTestSession();
    const snapshot = (key: string) => ({
      prunedToolResults: [],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [{ key, sourceHash: "source", texts: [key] }],
    });
    manager.appendCustomEntry("openclaw.cache-ttl", snapshot("older"));
    const activeMarker = manager.appendCustomEntry("openclaw.cache-ttl", snapshot("active"));
    manager.appendCustomEntry("openclaw.cache-ttl", snapshot("sibling"));
    manager.branch(activeMarker);

    const restored = createToolResultPromptProjectionState();
    restoreCacheTtlToolResultProjections(restored, manager.getBranch());
    expect(serializeCacheTtlToolResultProjections(restored)).toEqual(snapshot("active"));
    const appendEntry = (customType: string, data: unknown) =>
      manager.appendCustomEntry(customType, data);
    const markers = () =>
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "openclaw.cache-ttl");
    persistToolResultProjections(restored, appendEntry);
    expect(markers()).toHaveLength(3);

    restored.replacements.set("active", { content: [{ type: "text", text: "changed" }] });
    expect(() =>
      persistToolResultProjections(restored, () => {
        throw new Error("write failed");
      }),
    ).toThrow("write failed");
    persistToolResultProjections(restored, appendEntry);
    persistToolResultProjections(restored, appendEntry);
    expect(markers()).toHaveLength(4);
    expect(manager.getBranch().at(-1)).toMatchObject({
      data: { frozenToolResults: [{ key: "active", sourceHash: "source", texts: ["changed"] }] },
    });
  });

  it("writes one marker for unchanged requests and another for a new frozen batch", async () => {
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
        persistToolResultProjections(projectionState, (customType, data) =>
          manager.appendCustomEntry(customType, data),
        );
      },
      promptActiveSession: async () => {
        const messages: Context["messages"] = [];
        for (let index = 0; index < 2; index++) {
          messages.push(createAssistant(testModel, [{ type: "text", text: "read" }]), {
            role: "toolResult",
            toolCallId: `batch-${index}`,
            toolName: "read",
            content: [{ type: "text", text: "x".repeat(6_000) }],
            isError: false,
            timestamp: index,
          });
          for (let request = 0; request < 3; request++) {
            await activeSession.agent.streamFn(testModel, { messages });
            expect(manager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(
              index + 1,
            );
          }
        }
      },
    });
    expect(requests).toHaveLength(6);
    expect(manager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(2);
    expect(requests[3]?.slice(0, 2)).toEqual(requests[0]);
  });
});
