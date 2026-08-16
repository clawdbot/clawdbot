import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindCodexSettledTurnFinalizationRejectionReceipt,
  captureCodexSettledTurnFinalizationContext,
  type CodexSettledTurnFinalizationRejectionReason,
} from "./settled-turn-context.js";
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

    const result = await captureContext({
      historyMessages,
      mirroredMessages: settledMessages,
      settledMessages,
      turnId: "turn-2",
    });
    const expected = {
      source: "openclaw-transcript" as const,
      messages: [prior, ...settledMessages],
    };

    expect(result).toEqual({ ok: true, context: expected });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.stringify(result.context)).toBe(JSON.stringify(expected));
    expect(Object.isFrozen(result.context.messages)).toBe(true);
    expect(result.context.messages).not.toBe(historyMessages);
  });

  it("adopts an exact host-persisted prompt without rewriting its canonical metadata", async () => {
    const { persistedPrompt, ...turn } = settledHostPromptTurn();

    const result = await captureContext(turn);
    const expected = { source: "openclaw-transcript" as const, messages: turn.historyMessages };

    expect(result).toEqual({ ok: true, context: expected });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.stringify(result.context)).toBe(JSON.stringify(expected));
    expect(Object.isFrozen(result.context.messages)).toBe(true);
    expect(result.context.messages[0]).toEqual(persistedPrompt);
    expect(readMirrorIdentity(result.context.messages[0]!)).toBeUndefined();
    expect(readUpstreamUserText(result.context.messages[0]!)).toBeUndefined();
    expect(result.context.messages[0]).toMatchObject({
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

    await expect(captureContext(turn)).resolves.toEqual({
      ok: false,
      reason: "mirror-boundary-order",
    });
  });

  it("rejects duplicate host-persisted prompt idempotency keys", async () => {
    const turn = settledHostPromptTurn();
    turn.historyMessages.unshift({ ...turn.persistedPrompt });

    await expect(captureContext(turn)).resolves.toEqual({
      ok: false,
      reason: "mirror-boundary-order",
    });
  });

  it.each([
    {
      name: "missing history",
      reason: "missing-history" as const,
      historyMessages: undefined,
      mirroredMessages: settledTurn(),
      settledMessages: settledTurn(),
    },
    {
      name: "foreign boundary turn",
      reason: "missing-boundary-identity" as const,
      historyMessages: settledTurn(),
      mirroredMessages: settledTurn(),
      settledMessages: settledTurn(),
      turnId: "turn-3",
    },
    {
      name: "missing current prompt",
      reason: "required-identity-shape" as const,
      historyMessages: settledTurn(),
      mirroredMessages: settledTurn().slice(1),
      settledMessages: settledTurn().slice(1),
    },
    {
      name: "duplicate persisted identity",
      reason: "duplicate-history-identity" as const,
      historyMessages: [...settledTurn(), settledTurn()[2]!],
      mirroredMessages: settledTurn(),
      settledMessages: settledTurn(),
    },
    {
      name: "duplicate mirrored identity",
      reason: "duplicate-mirror-identity" as const,
      historyMessages: settledTurn(),
      mirroredMessages: [...settledTurn(), settledTurn()[2]!],
      settledMessages: settledTurn(),
    },
    {
      name: "reordered mirrored messages",
      reason: "mirror-boundary-order" as const,
      historyMessages: settledTurn(),
      mirroredMessages: (() => {
        const settledMessages = settledTurn();
        return [settledMessages[1]!, settledMessages[0]!, settledMessages[2]!];
      })(),
      settledMessages: settledTurn(),
    },
    {
      name: "missing history boundary",
      reason: "history-boundary" as const,
      historyMessages: settledTurn().slice(0, 2),
      mirroredMessages: settledTurn(),
      settledMessages: settledTurn(),
    },
    {
      name: "reordered history through the boundary",
      reason: "history-boundary-order" as const,
      historyMessages: (() => {
        const settledMessages = settledTurn();
        return [settledMessages[0]!, settledMessages[2]!, settledMessages[1]!];
      })(),
      mirroredMessages: settledTurn(),
      settledMessages: settledTurn(),
    },
    {
      name: "persisted payload drift under the same identity",
      reason: "source-evidence-mismatch" as const,
      historyMessages: (() => {
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
        return historyMessages;
      })(),
      mirroredMessages: settledTurn(),
      settledMessages: settledTurn(),
    },
  ] satisfies Array<{
    name: string;
    reason: CodexSettledTurnFinalizationRejectionReason;
    historyMessages: AgentMessage[] | undefined;
    mirroredMessages: AgentMessage[];
    settledMessages: AgentMessage[];
    turnId?: string;
  }>)(
    "rejects $name with $reason",
    async ({ reason, historyMessages, mirroredMessages, settledMessages, turnId }) => {
      if (historyMessages === undefined) {
        mocks.readHistory.mockResolvedValue(undefined);
      } else {
        mocks.readHistory.mockResolvedValue(historyMessages);
      }
      const result = await captureCodexSettledTurnFinalizationContext({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        mirroredMessages,
        settledMessages,
        turnId: turnId ?? "turn-2",
      });
      expect(result).toEqual({ ok: false, reason });
      expect(result).not.toHaveProperty("context");
      expect(JSON.stringify(result)).not.toMatch(
        /Send it|different result|session\.jsonl|session-1|arguments/,
      );
    },
  );

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
    ).resolves.toEqual({ ok: false, reason: "capture-error" });
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
    ).resolves.toEqual({ ok: false, reason: "capture-error" });
  });

  it("binds rejection receipts to reason and existing identities only", () => {
    const receipt = bindCodexSettledTurnFinalizationRejectionReceipt({
      reason: "source-evidence-mismatch",
      threadId: "thread-1",
      turnId: "turn-2",
      runId: "run-9",
    });
    expect(Object.keys(receipt).sort()).toEqual(["reason", "runId", "threadId", "turnId"]);
    expect(receipt).toEqual({
      reason: "source-evidence-mismatch",
      threadId: "thread-1",
      turnId: "turn-2",
      runId: "run-9",
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /Send it|different result|session\.jsonl|toolCall|arguments|content/,
    );
  });
});
