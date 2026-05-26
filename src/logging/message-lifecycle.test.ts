import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  logMessageProcessed: vi.fn(),
  logMessageQueued: vi.fn(),
  logSessionStateChange: vi.fn(),
}));

vi.mock("./diagnostic.js", () => ({
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));

import { createDiagnosticMessageLifecycle } from "./message-lifecycle.js";

describe("createDiagnosticMessageLifecycle", () => {
  beforeEach(() => {
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
  });

  it("emits queued, state, and processed events through one lifecycle", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "cron",
      source: "cron-isolated",
      sessionId: "initial-session",
      sessionKey: "cron:job",
      trackSessionState: true,
    });

    lifecycle.markProcessing();
    lifecycle.markIdle(undefined, { sessionId: "final-session" });
    lifecycle.markProcessed("completed", {
      sessionId: "final-session",
      durationMs: 42,
    });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledWith({
      sessionId: "initial-session",
      sessionKey: "cron:job",
      channel: "cron",
      source: "cron-isolated",
    });
    expect(diagnosticMocks.logSessionStateChange.mock.calls).toEqual([
      [
        {
          sessionId: "initial-session",
          sessionKey: "cron:job",
          state: "processing",
          reason: undefined,
        },
      ],
      [
        {
          sessionId: "final-session",
          sessionKey: "cron:job",
          state: "idle",
          reason: undefined,
        },
      ],
    ]);
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith({
      channel: "cron",
      chatId: undefined,
      messageId: undefined,
      sessionId: "final-session",
      sessionKey: "cron:job",
      durationMs: 42,
      outcome: "completed",
      reason: undefined,
      error: undefined,
    });
  });

  it("keeps processed events independent of session-state tracking", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "whatsapp",
      source: "dispatch",
      chatId: "chat-1",
      messageId: "msg-1",
      trackSessionState: false,
    });

    lifecycle.markProcessing();
    lifecycle.markIdle("message_completed");
    lifecycle.markProcessed("skipped", {
      durationMs: 7,
      reason: "duplicate",
    });

    expect(diagnosticMocks.logMessageQueued).not.toHaveBeenCalled();
    expect(diagnosticMocks.logSessionStateChange).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith({
      channel: "whatsapp",
      chatId: "chat-1",
      messageId: "msg-1",
      sessionId: undefined,
      sessionKey: undefined,
      durationMs: 7,
      outcome: "skipped",
      reason: "duplicate",
      error: undefined,
    });
  });

  it("emits nothing when disabled", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: false,
      channel: "slack",
      source: "dispatch",
      sessionKey: "agent:main",
      trackSessionState: true,
    });

    lifecycle.markProcessing();
    lifecycle.markIdle("message_completed");
    lifecycle.markProcessed("completed", { durationMs: 1 });

    expect(diagnosticMocks.logMessageQueued).not.toHaveBeenCalled();
    expect(diagnosticMocks.logSessionStateChange).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).not.toHaveBeenCalled();
  });
});
