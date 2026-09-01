import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureCodexSettledTurnFinalizationContext } from "./settled-turn-context.js";
import { attachCodexMirrorAttestation } from "./transcript-mirror-attestation.js";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readMirrorIdentity,
  readUpstreamUserText,
} from "./upstream-prompt-provenance.js";

const mocks = vi.hoisted(() => ({
  readHistory: vi.fn(),
}));

vi.mock("./session-history.js", () => ({
  readCodexMirroredSessionHistory: mocks.readHistory,
}));

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
  });
}

describe("captureCodexSettledTurnFinalizationContext", () => {
  beforeEach(() => {
    mocks.readHistory.mockReset();
  });

  it("freezes the complete active branch exactly through the current tool-result boundary", async () => {
    const prior = message({ role: "user", content: "Alice is the recipient." }, "turn-1:prompt");
    const settledMessages = settledTurn();
    const later = message({ role: "user", content: "later message" }, "turn-3:prompt");
    const historyMessages = [prior, ...settledMessages, later];

    const context = await captureContext({
      historyMessages,
      mirroredMessages: settledMessages,
      settledMessages,
      turnId: "turn-2",
    });

    Object.assign(prior, { content: "changed after capture" });
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
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context?.data)).toBe(true);
    expect(Object.isFrozen(context?.data[0])).toBe(true);
  });

  it("adopts an exact host-persisted prompt without rewriting its canonical metadata", async () => {
    const { persistedPrompt, ...turn } = settledHostPromptTurn();

    const context = await captureContext(turn);

    expect(context?.data[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Send it." }],
    });
    expect(readMirrorIdentity(persistedPrompt)).toBeUndefined();
    expect(readUpstreamUserText(persistedPrompt)).toBeUndefined();
    expect(persistedPrompt).toMatchObject({
      __openclaw: { senderIsOwner: true, transport: { messageId: "transport-message" } },
    });
  });

  it.each([
    {
      name: "missing persisted key",
      change: (prompt: AgentMessage) => ({ ...prompt, idempotencyKey: undefined }),
    },
    {
      name: "different persisted key",
      change: (prompt: AgentMessage) => ({ ...prompt, idempotencyKey: "different-user-turn" }),
    },
    {
      name: "changed prompt content",
      change: (prompt: AgentMessage) => ({ ...prompt, content: "Send something else." }),
    },
    {
      name: "conflicting mirror identity",
      change: (prompt: AgentMessage) => attachCodexMirrorIdentity(prompt, "foreign-turn:prompt"),
    },
    {
      name: "Codex mirror origin without a fingerprint",
      change: (prompt: AgentMessage) => attachCodexMirrorAttestation(prompt),
    },
    {
      name: "Codex source fingerprint without an origin",
      change: (prompt: AgentMessage) => ({
        ...prompt,
        __openclaw: { mirrorSourceFingerprint: "stale-fingerprint" },
      }),
    },
    {
      name: "conflicting upstream prompt",
      change: (prompt: AgentMessage) =>
        attachUpstreamUserText(prompt, "Untrusted upstream prompt."),
    },
  ])("rejects host-persisted prompt adoption with $name", async ({ change }) => {
    const turn = settledHostPromptTurn();
    turn.historyMessages[0] = change(turn.persistedPrompt) as AgentMessage;

    await expect(captureContext(turn)).resolves.toBeUndefined();
  });

  it.each(["before", "after"])(
    "rejects duplicate host prompt keys %s the settled boundary",
    async (position) => {
      const turn = settledHostPromptTurn();
      if (position === "before") {
        turn.historyMessages.unshift({ ...turn.persistedPrompt });
      } else {
        turn.historyMessages.push({ ...turn.persistedPrompt });
      }
      await expect(captureContext(turn)).resolves.toBeUndefined();
    },
  );

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
        mirroredMessages: settledMessages,
        settledMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });
});
