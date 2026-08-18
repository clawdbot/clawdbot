// Tests /steer target capture, accepted delivery, and visible fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import type { ReplyBackendQueueMessageOptions, ReplyOperation } from "./reply-run-registry.js";
import { createReplyOperation } from "./reply-run-registry.js";

const { handleSteerCommand } = await import("./commands-steer.js");

const baseCfg = {
  commands: { text: true },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;
const queueMessage = vi.fn(
  async (_text: string, _options?: ReplyBackendQueueMessageOptions) => undefined,
);
const operations: ReplyOperation[] = [];

function buildParams(commandBody: string) {
  return buildCommandTestParams(commandBody, baseCfg);
}

function beginActiveOperation(
  sessionKey: string,
  sessionId = "session-active",
  taskSuggestionDeliveryMode?: "gateway",
) {
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    cancel: vi.fn(),
    taskSuggestionDeliveryMode,
    messageInjection: { isAvailable: () => true, queueMessage },
  });
  operations.push(operation);
  return operation;
}

describe("handleSteerCommand", () => {
  beforeEach(() => queueMessage.mockReset().mockResolvedValue(undefined));

  afterEach(() => {
    for (const operation of operations.splice(0)) {
      operation.complete();
    }
  });

  it("injects into the captured current text-command session", async () => {
    beginActiveOperation("agent:main:main");

    const result = await handleSteerCommand(buildParams("/steer keep going"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered current session." },
    });
    expect(queueMessage).toHaveBeenCalledWith("keep going", {
      steeringMode: "all",
      debounceMs: 0,
      taskSuggestionDeliveryMode: undefined,
      onQueueAccepted: expect.any(Function),
    });
  });

  it("passes the initiating surface task capability into steering", async () => {
    beginActiveOperation("agent:main:main", "session-active", "gateway");
    const params = buildParams("/steer keep going");
    params.opts = { taskSuggestionDeliveryMode: "gateway" };

    await handleSteerCommand(params, true);

    expect(queueMessage).toHaveBeenCalledWith(
      "keep going",
      expect.objectContaining({ taskSuggestionDeliveryMode: "gateway" }),
    );
  });

  it("prefers the native command target over the slash-command source", async () => {
    beginActiveOperation("agent:main:discord:direct:target", "session-target");
    const params = buildParams("/steer check the target");
    params.ctx.CommandSource = "native";
    params.ctx.CommandTargetSessionKey = "agent:main:discord:direct:target";
    params.sessionKey = "agent:main:discord:slash:user";

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered current session." },
    });
    expect(queueMessage).toHaveBeenCalledWith("check the target", expect.any(Object));
  });

  it("maps a text slash source lane to its active direct conversation", async () => {
    beginActiveOperation("agent:main:telegram:direct:123", "session-direct-active");
    const params = buildParams("/steer use the active direct lane");
    params.sessionKey = "agent:main:telegram:slash:123";

    await handleSteerCommand(params, true);

    expect(queueMessage).toHaveBeenCalledWith("use the active direct lane", expect.any(Object));
  });

  it("returns usage for an empty steer command", async () => {
    const result = await handleSteerCommand(buildParams("/steer"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /steer <message>" },
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("continues visibly as a normal prompt when no direct owner is active", async () => {
    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.Body).toBe("keep going");
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("continues visibly as a normal prompt when captured injection rejects", async () => {
    beginActiveOperation("agent:main:main");
    queueMessage.mockRejectedValueOnce(new Error("runtime rejected"));
    const params = buildParams("/steer keep going");

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
  });
});
