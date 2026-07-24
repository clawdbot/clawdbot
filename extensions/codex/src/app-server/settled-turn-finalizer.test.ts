import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
} from "./transcript-mirror-attestation.js";

const mocks = vi.hoisted(() => ({
  runBounded: vi.fn(),
  mirror: vi.fn(),
}));

vi.mock("./bounded-turn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bounded-turn.js")>()),
  runBoundedCodexAppServerTurn: mocks.runBounded,
}));

vi.mock("./transcript-mirror.js", () => ({
  codexTranscriptMirrorRuntime: { mirror: mocks.mirror },
}));

const { runCodexSettledTurnFinalization } = await import("./settled-turn-finalizer.js");

function createAttempt(): EmbeddedRunAttemptParams {
  return {
    prompt: "Produce the final user-visible answer now.",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    runId: "run-1",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: {
      id: "gpt-5.4",
      provider: "codex",
      api: "openai-chatgpt-responses",
    } as Model,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
  } as EmbeddedRunAttemptParams;
}

function createSettledAttempt(): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "message", arguments: {} }],
      } as never,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "message",
        content: [{ type: "text", text: "Message sent." }],
      } as never,
    ],
    settledTurnFinalizationContext: {
      source: "openclaw-transcript",
      messages: [
        { role: "user", content: "Send the update to Alice." } as never,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "message", arguments: {} }],
        } as never,
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "message",
          content: [{ type: "text", text: "Message sent." }],
        } as never,
      ],
    },
    assistantTexts: [],
    toolMetas: [{ toolName: "message", replaySafe: false }],
    lastAssistant: undefined,
    lastToolError: undefined,
    didSendViaMessagingTool: true,
    messagingToolSentTexts: ["update"],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    toolMediaUrls: ["/tmp/already-delivered.png"],
    toolAudioAsVoice: true,
    hasToolMediaBlockReply: true,
    successfulCronAdds: 1,
    cloudCodeAssistFormatError: false,
    attemptUsage: { input: 100, output: 20, total: 120 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
  };
}

describe("runCodexSettledTurnFinalization", () => {
  beforeEach(() => {
    mocks.runBounded.mockReset();
    mocks.runBounded.mockResolvedValue({
      text: "The update was sent successfully.",
      items: [],
      model: "gpt-5.4",
      usage: { input: 5, output: 4, cacheRead: 2, cacheWrite: 1, total: 12 },
    });
    mocks.mirror.mockReset();
    mocks.mirror.mockImplementation(
      async (params: { messages: EmbeddedRunAttemptResult["messagesSnapshot"] }) => {
        const assistant = params.messages[0]!;
        return {
          assistantMirrorIdentitiesOwned: ["settled-finalizer:run-1"],
          messagesPresent: [
            attachCodexMirrorAttestation(
              Object.assign({}, assistant, {
                idempotencyKey: "codex-settled-finalizer:run-1:assistant",
              }),
              fingerprintCodexMirrorSourceMessage(assistant as never),
            ),
          ],
          userMessagesPresent: [],
        };
      },
    );
  });

  it("binds tool-result failure status into mirror attestations", () => {
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "message",
      content: [{ type: "text", text: "Message sent." }],
    };

    expect(fingerprintCodexMirrorSourceMessage(toolResult as never)).not.toBe(
      fingerprintCodexMirrorSourceMessage({ ...toolResult, isError: true } as never),
    );
  });

  it("runs an isolated history-backed final turn and returns only its visible answer", async () => {
    const result = await runCodexSettledTurnFinalization(
      { attempt: createAttempt(), settledAttempt: createSettledAttempt() },
      { pluginConfig: {} },
    );

    expect(mocks.runBounded).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: "private-stdio",
        requireNoExternalCapabilities: true,
        historyItems: [
          expect.objectContaining({ type: "message", role: "user" }),
          expect.objectContaining({ type: "function_call", call_id: "call-1" }),
          expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
        ],
        input: [
          {
            type: "text",
            text: "Produce the final user-visible answer now.",
            text_elements: [],
          },
        ],
      }),
    );
    expect(mocks.mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        idempotencyScope: "codex-settled-finalizer:run-1",
        skipBeforeMessageWriteHooks: true,
        messages: [expect.objectContaining({ role: "assistant" })],
      }),
    );
    expect(result).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "codex-settled-finalizer:run-1:assistant",
      usage: { input: 5, output: 4, cacheRead: 2, cacheWrite: 1, total: 12 },
      assistant: {
        role: "assistant",
        content: [{ type: "text", text: "The update was sent successfully." }],
      },
    });
    expect(result.assistant.content).toEqual([
      { type: "text", text: "The update was sent successfully." },
    ]);
    expect(result.assistant.usage).toMatchObject({
      input: 5,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 12,
    });
  });

  it("rejects an empty final answer before transcript mutation", async () => {
    mocks.runBounded.mockResolvedValue({ text: " ", items: [], model: "gpt-5.4" });

    await expect(
      runCodexSettledTurnFinalization(
        { attempt: createAttempt(), settledAttempt: createSettledAttempt() },
        {},
      ),
    ).rejects.toThrow("completed without a visible answer");
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("rejects an intentionally silent final answer before transcript mutation", async () => {
    mocks.runBounded.mockResolvedValue({ text: "NO_REPLY", items: [], model: "gpt-5.4" });

    await expect(
      runCodexSettledTurnFinalization(
        { attempt: createAttempt(), settledAttempt: createSettledAttempt() },
        {},
      ),
    ).rejects.toThrow("completed without a visible answer");
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("does not mutate the transcript when the bounded turn is interrupted", async () => {
    mocks.runBounded.mockRejectedValue(
      new Error("codex app-server settled-turn finalization turn ended with status interrupted"),
    );

    await expect(
      runCodexSettledTurnFinalization(
        { attempt: createAttempt(), settledAttempt: createSettledAttempt() },
        {},
      ),
    ).rejects.toThrow("turn ended with status interrupted");
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it.each(["commandExecution", "contextCompaction", "mcpToolCall", "futureCapabilityItem"])(
    "rejects unexpected native %s evidence before transcript mutation",
    async (type) => {
      mocks.runBounded.mockResolvedValue({
        text: "The update was sent successfully.",
        items: [{ id: "item-1", type }],
        model: "gpt-5.4",
      });

      await expect(
        runCodexSettledTurnFinalization(
          { attempt: createAttempt(), settledAttempt: createSettledAttempt() },
          {},
        ),
      ).rejects.toThrow(`unexpected native item: ${type}`);
      expect(mocks.mirror).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing frozen context before starting the isolated turn", async () => {
    const settledAttempt = createSettledAttempt();
    delete settledAttempt.settledTurnFinalizationContext;

    await expect(
      runCodexSettledTurnFinalization({ attempt: createAttempt(), settledAttempt }, {}),
    ).rejects.toThrow("finalization context is unavailable");
    expect(mocks.runBounded).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("rejects a stale idempotency hit instead of delivering an unpersisted answer", async () => {
    mocks.mirror.mockImplementation(
      async (params: { messages: EmbeddedRunAttemptResult["messagesSnapshot"] }) => {
        const staleAssistant = {
          ...params.messages[0]!,
          content: [{ type: "text", text: "An older final answer." }],
        } as (typeof params.messages)[number];
        return {
          assistantMirrorIdentitiesOwned: ["settled-finalizer:run-1"],
          messagesPresent: [
            attachCodexMirrorAttestation(
              staleAssistant,
              fingerprintCodexMirrorSourceMessage(staleAssistant as never),
            ),
          ],
          userMessagesPresent: [],
        };
      },
    );

    await expect(
      runCodexSettledTurnFinalization(
        { attempt: createAttempt(), settledAttempt: createSettledAttempt() },
        {},
      ),
    ).rejects.toThrow("transcript attestation mismatch");
  });
});
