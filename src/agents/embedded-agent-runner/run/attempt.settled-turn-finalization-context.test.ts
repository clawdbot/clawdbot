// Proves the attempt-result owner supplies the settled transcript the tool-free
// finalizer requires when the final post-tool provider call dies transiently.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

function transientFinalCallFailure() {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

async function runSettledTurnWithFailedFinalCall(
  sessionKey: string,
  error: Error = transientFinalCallFailure(),
) {
  return await createContextEngineAttemptRunner({
    contextEngine: createContextEngineBootstrapAndAssemble(),
    sessionKey,
    tempPaths,
    sessionPrompt: async (session) => {
      // The tools of this turn already ran and their results are persisted;
      // only the side-effect-free delivery call is still outstanding.
      session.messages = [
        ...session.messages,
        {
          role: "assistant",
          stopReason: "toolUse",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call-read", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          isError: false,
          timestamp: 3,
          content: [{ type: "text", text: "file contents" }],
        },
      ];
      throw error;
    },
  });
}

describe("settled post-tool turn finalization context", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    { kind: "transient", error: transientFinalCallFailure(), captures: true },
    { kind: "non-transient", error: new Error("invalid api key"), captures: false },
    {
      kind: "incomplete-completions-stream",
      error: new Error("Stream ended without finish_reason"),
      captures: true,
    },
  ])("$kind final provider failure captures context=$captures", async ({ error, captures }) => {
    const result = await runSettledTurnWithFailedFinalCall(
      "agent:main:telegram:direct:settled",
      error,
    );

    expect(result.terminal.kind).toBe("failed");
    expect(result.assistantTexts.every((text) => !text.trim())).toBe(true);
    // Without this context the provider-failure branch of incomplete-turn
    // recovery fails closed and the whole completed turn is discarded.
    const context = result.settledTurnFinalizationContext;
    if (!captures) {
      expect(context).toBeUndefined();
      return;
    }
    if (context?.source !== "openclaw-transcript") {
      throw new Error("Expected the built-in settled transcript context");
    }
    expect(context.messages.some((message) => message.role === "toolResult")).toBe(true);
    expect(Object.isFrozen(context.messages)).toBe(true);
  });

  it("omits the context when the turn settled no tool result", async () => {
    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:no-tools",
      tempPaths,
      sessionPrompt: async () => {
        throw transientFinalCallFailure();
      },
    });

    expect(result.terminal.kind).toBe("failed");
    expect(result.settledTurnFinalizationContext).toBeUndefined();
  });

  it("omits the context when the turn already produced visible assistant text", async () => {
    const baseSubscribe = hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation();
    if (!baseSubscribe) {
      throw new Error("missing embedded subscription mock");
    }
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => ({
      ...baseSubscribe(params),
      assistantTexts: ["here is the answer"],
    }));

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:answered",
      tempPaths,
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            isError: false,
            timestamp: 2,
            content: [{ type: "text", text: "file contents" }],
          },
        ];
        throw transientFinalCallFailure();
      },
    });

    // A turn that already composed an answer has nothing to finalize.
    expect(result.settledTurnFinalizationContext).toBeUndefined();
  });
});
