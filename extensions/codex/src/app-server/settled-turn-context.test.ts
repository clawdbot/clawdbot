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
  readCodexMirroredSessionHistoryMessages: mocks.readHistory,
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
  mocks.readHistory.mockResolvedValue(params.historyMessages);
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

    expect(context).toEqual({
      source: "openclaw-transcript",
      messages: [prior, ...settledMessages],
    });
    expect(Object.isFrozen(context?.messages)).toBe(true);
    expect(context?.messages).not.toBe(historyMessages);
  });

  it("adopts an exact host-persisted prompt without rewriting its canonical metadata", async () => {
    const { persistedPrompt, ...turn } = settledHostPromptTurn();

    const context = await captureContext(turn);

    expect(context).toEqual({ source: "openclaw-transcript", messages: turn.historyMessages });
    expect(Object.isFrozen(context?.messages)).toBe(true);
    expect(context?.messages[0]).toEqual(persistedPrompt);
    expect(readMirrorIdentity(context!.messages[0]!)).toBeUndefined();
    expect(readUpstreamUserText(context!.messages[0]!)).toBeUndefined();
    expect(context?.messages[0]).toMatchObject({
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
      name: "stale Codex mirror attestation",
      change: (prompt: AgentMessage) => attachCodexMirrorAttestation(prompt, "stale-fingerprint"),
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

  it("rejects duplicate host-persisted prompt idempotency keys", async () => {
    const turn = settledHostPromptTurn();
    turn.historyMessages.unshift({ ...turn.persistedPrompt });

    await expect(captureContext(turn)).resolves.toBeUndefined();
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

  it("contains transcript clone failures after tools have settled", async () => {
    const historyMessages = settledTurn();
    Object.assign(historyMessages[2]!, { uncloneable: () => undefined });
    mocks.readHistory.mockResolvedValue(historyMessages);

    await expect(
      captureCodexSettledTurnFinalizationContext({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        mirroredMessages: historyMessages,
        settledMessages: historyMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });
});
