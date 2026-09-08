import { embeddedAgentLog, type AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexHistoryRejection } from "./history-rejection.js";
import { captureCodexSettledTurnFinalizationContext } from "./settled-turn-context.js";
import { attachCodexMirrorIdentity, attachUpstreamUserText } from "./upstream-prompt-provenance.js";

const mocks = vi.hoisted(() => ({
  readHistory: vi.fn(),
}));

vi.mock("../../session-history-worker-runtime.js", async () => {
  const { projectVerifiedSettledCodexMessages } = await import("./settled-turn-evidence.js");
  const { codexHistoryRejectionReason } = await import("./history-rejection.js");
  return {
    projectCodexSettledHistoryInWorker: async (
      params: Parameters<typeof projectVerifiedSettledCodexMessages>[1],
    ) => {
      try {
        const value = await mocks.readHistory(params, (messages: Iterable<AgentMessage>) =>
          projectVerifiedSettledCodexMessages(messages, params),
        );
        return { status: "ok", value };
      } catch (error) {
        return { status: "rejected", reason: codexHistoryRejectionReason(error) };
      }
    },
  };
});

function message(value: unknown, identity: string): AgentMessage {
  return attachCodexMirrorIdentity(value as AgentMessage, identity);
}

function settledTurn() {
  return [
    message({ role: "user", content: "Send it." }, "turn-2:prompt"),
    message(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-2", name: "message", arguments: {} }],
      },
      "turn-2:tool:call-2:call",
    ),
    message(
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "message",
        content: [{ type: "text", text: "sent" }],
      },
      "turn-2:tool:call-2:result",
    ),
  ];
}

function settledHostPromptTurn() {
  const settledMessages = settledTurn();
  settledMessages[0] = attachUpstreamUserText(
    message(
      { role: "user", content: "Send it.", idempotencyKey: "durable-user-turn" },
      "turn-2:prompt",
    ),
    "Decorated upstream prompt: Send it.",
  );
  const persistedPrompt = {
    role: "user",
    content: "Send it.",
    timestamp: 1,
    idempotencyKey: "durable-user-turn",
    __openclaw: { senderIsOwner: true, transport: { messageId: "transport-message" } },
  } as AgentMessage;
  return {
    settledMessages,
    persistedPrompt,
    historyMessages: [persistedPrompt, ...settledMessages.slice(1)],
    mirroredMessages: settledMessages.slice(1),
  };
}

async function captureContext(params: {
  historyMessages: AgentMessage[];
  mirroredMessages: AgentMessage[];
  settledMessages: AgentMessage[];
  turnId?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
}) {
  mocks.readHistory.mockImplementation(
    (_target, read: (messages: Iterable<AgentMessage>) => unknown) => read(params.historyMessages),
  );
  return captureCodexSettledTurnFinalizationContext({
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
    mirroredMessages: params.mirroredMessages,
    settledMessages: params.settledMessages,
    turnId: params.turnId ?? "turn-2",
    model: params.model ?? "gpt-5.6-luna",
    modelProvider: params.modelProvider,
    authProfileId: params.authProfileId,
  });
}

describe("captureCodexSettledTurnFinalizationContext", () => {
  beforeEach(() => {
    mocks.readHistory.mockReset();
  });

  it.each([
    { ending: "abort", rejected: false },
    { ending: "abort", rejected: true },
    { ending: "closure", rejected: false },
    { ending: "closure", rejected: true },
  ])(
    "keeps owner $ending ahead of capture diagnostics (rejected=$rejected)",
    async ({ ending, rejected }) => {
      const messages = settledTurn();
      const reading = createDeferred<void>();
      const finish = createDeferred<void>();
      const controller = new AbortController();
      let active = true;
      mocks.readHistory.mockImplementationOnce(async (_target, read) => {
        reading.resolve();
        await finish.promise;
        if (rejected) {
          throw new CodexHistoryRejection("field_limit");
        }
        return read(messages);
      });
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const pending = captureCodexSettledTurnFinalizationContext({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        mirroredMessages: messages,
        settledMessages: messages,
        turnId: "turn-2",
        model: "gpt-5.6-luna",
        signal: controller.signal,
        assertActive: () => {
          if (!active) {
            throw new Error("synthetic owner closed");
          }
        },
      });
      await reading.promise;
      if (ending === "abort") {
        controller.abort(new Error("synthetic capture aborted"));
      } else {
        active = false;
      }
      finish.resolve();
      try {
        await expect(pending).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          "codex settled-turn finalization context capture failed",
          { reason: ending === "abort" ? "cancelled" : "history_read_failed" },
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each([undefined, "openai"])(
    "freezes source selection and the exact settled branch (provider: %s)",
    async (modelProvider) => {
      const prior = message({ role: "user", content: "Alice is the recipient." }, "turn-1:prompt");
      const settledMessages = settledTurn();
      const later = message({ role: "user", content: "later message" }, "turn-3:prompt");
      const historyMessages = [prior, ...settledMessages, later];
      const selection = { model: "gpt-5.6-luna", modelProvider, authProfileId: "openai:captured" };

      const context = await captureContext({
        historyMessages,
        mirroredMessages: settledMessages,
        settledMessages,
        turnId: "turn-2",
        ...selection,
      });

      Object.assign(prior, { content: "changed after capture" });
      Object.assign(selection, { model: "changed-model", authProfileId: "openai:changed" });
      expect(context?.data).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Alice is the recipient." }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Send it." }] },
        { type: "function_call", call_id: "call-2", name: "message", arguments: "{}" },
        { type: "function_call_output", call_id: "call-2", output: "sent" },
      ]);
      expect(context?.selection).toEqual({
        model: "gpt-5.6-luna",
        modelProvider,
        authProfileId: "openai:captured",
      });
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context?.data)).toBe(true);
      expect(Object.isFrozen(context?.data[0])).toBe(true);
      expect(Object.isFrozen(context?.selection)).toBe(true);
    },
  );

  it.each([undefined, ""])(
    "refuses missing model %j without reading transcript evidence",
    async (model) => {
      const messages = settledTurn();
      mocks.readHistory.mockImplementation(
        (_target, read: (messages: Iterable<AgentMessage>) => unknown) => read(messages),
      );
      await expect(
        captureCodexSettledTurnFinalizationContext({
          sessionFile: "/tmp/session.jsonl",
          sessionId: "session-1",
          mirroredMessages: messages,
          settledMessages: messages,
          turnId: "turn-2",
          model,
        }),
      ).resolves.toBeUndefined();
      expect(mocks.readHistory).not.toHaveBeenCalled();
    },
  );

  it("refuses unannotated host prompts even with the same durable key and adjacent native messages", async () => {
    const turn = settledHostPromptTurn();
    const before = structuredClone(turn.historyMessages);
    await expect(captureContext(turn)).resolves.toBeUndefined();
    expect(turn.historyMessages).toEqual(before);
  });

  it.each([
    {
      name: "missing current prompt",
      settledMessages: settledTurn().slice(1),
      historyMessages: settledTurn(),
    },
    {
      name: "missing current tool call",
      settledMessages: settledTurn(),
      historyMessages: [settledTurn()[0]!, settledTurn()[2]!],
    },
    {
      name: "duplicate persisted identity",
      settledMessages: settledTurn(),
      historyMessages: [...settledTurn(), settledTurn()[2]!],
    },
    {
      name: "duplicate prompt after the settled boundary",
      settledMessages: settledTurn(),
      historyMessages: [...settledTurn(), settledTurn()[0]!],
    },
    {
      name: "foreign boundary turn",
      settledMessages: settledTurn(),
      historyMessages: settledTurn(),
      turnId: "turn-3",
    },
  ])("fails closed for $name", async ({ settledMessages, historyMessages, turnId }) => {
    await expect(
      captureContext({
        historyMessages,
        mirroredMessages: settledMessages,
        settledMessages,
        turnId: turnId ?? "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a persisted payload drifts under the same mirror identity", async () => {
    const settledMessages = settledTurn();
    const historyMessages = settledTurn();
    historyMessages[2] = message(
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "message",
        content: [{ type: "text", text: "different result" }],
      },
      "turn-2:tool:call-2:result",
    );

    await expect(
      captureContext({
        historyMessages,
        mirroredMessages: settledMessages,
        settledMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when current mirrored messages are reordered", async () => {
    const settledMessages = settledTurn();
    await expect(
      captureContext({
        historyMessages: settledMessages,
        mirroredMessages: [settledMessages[1]!, settledMessages[0]!, settledMessages[2]!],
        settledMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("contains transcript read failures after tools have settled", async () => {
    mocks.readHistory.mockRejectedValue(new Error("read failed"));

    await expect(
      captureCodexSettledTurnFinalizationContext({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        model: "gpt-5.6-luna",
        mirroredMessages: settledTurn(),
        settledMessages: settledTurn(),
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("retains replay evidence without copying storage-only tool details", async () => {
    const historyMessages = settledTurn();
    Object.assign(historyMessages[2]!, { details: { payload: "x".repeat(1024 * 1024) } });
    const context = await captureContext({
      historyMessages,
      mirroredMessages: historyMessages,
      settledMessages: historyMessages,
    });
    expect(context?.data.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call-2",
      output: "sent",
    });
    expect(JSON.stringify(context).length).toBeLessThan(1024);
  });

  it("rejects a read failure after the complete prefix instead of accepting partial verification", async () => {
    const settledMessages = settledTurn();
    mocks.readHistory.mockImplementation(
      (_target, read: (messages: Iterable<AgentMessage>) => unknown) =>
        read(
          (function* () {
            yield* settledMessages;
            throw new Error("synthetic suffix read failure");
          })(),
        ),
    );
    await expect(
      captureCodexSettledTurnFinalizationContext({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        model: "gpt-5.6-luna",
        mirroredMessages: settledMessages,
        settledMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });
});
