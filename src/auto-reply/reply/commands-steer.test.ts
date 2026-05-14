import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const steerRuntimeMocks = vi.hoisted(() => ({
  formatEmbeddedPiQueueFailureSummary: vi.fn(),
  isEmbeddedPiRunActive: vi.fn(),
  queueEmbeddedPiMessageWithOutcomeAsync: vi.fn(),
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
    steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync.mockReset().mockResolvedValue({
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
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync).toHaveBeenCalledWith(
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
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync).toHaveBeenCalledWith(
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
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync).toHaveBeenCalledWith(
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
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("continues as a normal prompt when no current session run is active", async () => {
    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: true,
    });
    expect(params.ctx.Body).toBe("keep going");
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect((params.ctx as Record<string, unknown>).BodyStripped).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("continues as a normal prompt when the active run rejects steering injection", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync.mockResolvedValue({
      queued: false,
      sessionId: "session-active",
      reason: "not_streaming",
      gatewayHealth: "live",
    });

    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: true,
    });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(steerRuntimeMocks.formatEmbeddedPiQueueFailureSummary).toHaveBeenCalledWith({
      queued: false,
      sessionId: "session-active",
      reason: "not_streaming",
      gatewayHealth: "live",
    });
  });

  it("continues as a normal prompt when steering throws", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync.mockRejectedValue(
      new Error("socket closed"),
    );

    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: true,
    });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
  });

  it("continues as a normal prompt when the active run is compacting", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedPiMessageWithOutcomeAsync.mockResolvedValue({
      queued: false,
      sessionId: "session-active",
      reason: "compacting",
      gatewayHealth: "live",
    });

    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: true,
    });
    expect(params.ctx.BodyForAgent).toBe("keep going");
  });
});
