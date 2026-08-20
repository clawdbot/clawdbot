import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  persistAcpTurnTranscript: vi.fn(async () => ({ kind: "persisted" as const })),
  loadSessionEntryReadOnly: vi.fn(() => ({ sessionId: "session-acp-idempotent" })),
}));

vi.mock("../../agents/command/attempt-execution.js", () => ({
  persistAcpTurnTranscript: mocks.persistAcpTurnTranscript,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));

import { persistAcpDispatchTranscript } from "./dispatch-acp-transcript.runtime.js";

describe("persistAcpDispatchTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shares the gateway run-derived idempotency keys with ACP transcript writes", async () => {
    await persistAcpDispatchTranscript({
      cfg: {},
      sessionKey: "agent:main:main",
      promptText: "investigate this",
      finalText: "investigation complete",
      runId: "run-acp-idempotent",
    });

    expect(mocks.persistAcpTurnTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        userInput: {
          text: "investigate this",
          idempotencyKey: "run-acp-idempotent:user",
        },
        assistantIdempotencyKey: "run-acp-idempotent",
      }),
    );
  });
});
