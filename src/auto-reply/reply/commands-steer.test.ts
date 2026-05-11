import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const steerRuntimeMocks = vi.hoisted(() => ({
  formatEmbeddedPiQueueFailureSummary: vi.fn(),
  isEmbeddedPiRunActive: vi.fn(),
  queueEmbeddedPiMessageWithOutcome: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
}));

vi.mock("./commands-steer.runtime.js", () => steerRuntimeMocks);

const { handleSteerCommand } = await import("./commands-steer.js");

const baseCfg = {
  commands: { text: true },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

function buildParams(commandBody: string) {
  return buildCommandTestParams(commandBody, baseCfg);
}

describe("handleSteerCommand", () => {
  beforeEach(() => {
    steerRuntimeMocks.formatEmbeddedPiQueueFailureSummary
      .mockReset()
      .mockReturnValue(
        "queue_message_failed reason=not_streaming sessionId=session-active gatewayHealth=live",
      );
    steerRuntimeMocks.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    steerRuntimeMocks.queueEmbeddedPiMessageWithOutcome.mockReset().mockReturnValue({
      queued: true,
      sessionId: "session-active",
      target: "embedded_run",
      gatewayHealth: "live",
    });
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReset().mockReturnValue(undefined);
  });

  it("queues steering for the active current text-command session", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");

    const result = await handleSteerCommand(buildParams("/steer keep going"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered current session." },
    });
    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "agent:main:main",
    );
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledWith(
      "session-active",
      "keep going",
      {
        steeringMode: "all",
        debounceMs: 0,
      },
    );
  });

  it("prefers the native command target session key over the slash-command session", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-target");

    const params = buildParams("/steer check the target");
    params.ctx.CommandSource = "native";
    params.ctx.CommandTargetSessionKey = "agent:main:discord:direct:target";
    params.sessionKey = "agent:main:discord:slash:user";

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "agent:main:discord:direct:target",
    );
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledWith(
      "session-target",
      "check the target",
      {
        steeringMode: "all",
        debounceMs: 0,
      },
    );
  });

  it("falls back to the stored session id when it is still active", async () => {
    steerRuntimeMocks.isEmbeddedPiRunActive.mockReturnValue(true);

    const params = buildParams("/tell continue from state");
    params.sessionEntry = { sessionId: "stored-session-id", updatedAt: Date.now() };

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "agent:main:main",
    );
    expect(steerRuntimeMocks.isEmbeddedPiRunActive).toHaveBeenCalledWith("stored-session-id");
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledWith(
      "stored-session-id",
      "continue from state",
      {
        steeringMode: "all",
        debounceMs: 0,
      },
    );
  });

  it("returns usage for an empty steer command", async () => {
    const result = await handleSteerCommand(buildParams("/steer"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /steer <message>" },
    });
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcome).not.toHaveBeenCalled();
  });

  it("does not start a new run when no current session run is active", async () => {
    const result = await handleSteerCommand(buildParams("/steer keep going"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ No active run to steer in this session." },
    });
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcome).not.toHaveBeenCalled();
  });

  it("reports when the active run rejects steering injection", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedPiMessageWithOutcome.mockReturnValue({
      queued: false,
      sessionId: "session-active",
      reason: "not_streaming",
      gatewayHealth: "live",
    });

    const result = await handleSteerCommand(buildParams("/steer keep going"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ Current run is active but not accepting steering right now." },
    });
    expect(steerRuntimeMocks.formatEmbeddedPiQueueFailureSummary).toHaveBeenCalledWith({
      queued: false,
      sessionId: "session-active",
      reason: "not_streaming",
      gatewayHealth: "live",
    });
  });

  it("reports compacting runs distinctly", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedPiMessageWithOutcome.mockReturnValue({
      queued: false,
      sessionId: "session-active",
      reason: "compacting",
      gatewayHealth: "live",
    });

    const result = await handleSteerCommand(buildParams("/steer keep going"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ Current run is compacting; retry after compaction finishes." },
    });
  });
});
