import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const steerRuntimeMocks = vi.hoisted(() => ({
  isEmbeddedPiRunActive: vi.fn(),
  queueEmbeddedPiMessage: vi.fn(),
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
    steerRuntimeMocks.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    steerRuntimeMocks.queueEmbeddedPiMessage.mockReset().mockReturnValue(true);
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
    expect(steerRuntimeMocks.queueEmbeddedPiMessage).toHaveBeenCalledWith(
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
    expect(steerRuntimeMocks.queueEmbeddedPiMessage).toHaveBeenCalledWith(
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
    expect(steerRuntimeMocks.queueEmbeddedPiMessage).toHaveBeenCalledWith(
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
    expect(steerRuntimeMocks.queueEmbeddedPiMessage).not.toHaveBeenCalled();
  });

  it("does not start a new run when no current session run is active", async () => {
    const result = await handleSteerCommand(buildParams("/steer keep going"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ No active run to steer in this session." },
    });
    expect(steerRuntimeMocks.queueEmbeddedPiMessage).not.toHaveBeenCalled();
  });

  it("reports when the active run rejects steering injection", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedPiMessage.mockReturnValue(false);

    const result = await handleSteerCommand(buildParams("/steer keep going"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ Current run is active but not accepting steering right now." },
    });
  });
});
