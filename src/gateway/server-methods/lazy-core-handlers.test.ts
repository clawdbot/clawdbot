import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";

const runStackLoaded = vi.hoisted(() => vi.fn());
const sessionCreateStackLoaded = vi.hoisted(() => vi.fn());

vi.mock("./agent-run-handler.js", () => {
  runStackLoaded();
  return { agentRunHandler: vi.fn() };
});

vi.mock("../session-create-service.js", () => {
  sessionCreateStackLoaded();
  return {};
});

vi.mock("./chat.js", () => {
  throw new Error("Cancellation must not load chat history or send handlers");
});

vi.mock("../../tts/tts-synthesis.js", () => {
  throw new Error("Speech synthesis is unavailable");
});

describe("lazy core handler families", () => {
  it.each([
    {
      name: "paired client",
      params: { enabled: true, phase: "listening" },
      webchat: false,
      connectedTalkNode: false,
      errorCode: undefined,
    },
    {
      name: "webchat with a Talk node",
      params: { enabled: false },
      webchat: true,
      connectedTalkNode: true,
      errorCode: undefined,
    },
    {
      name: "webchat without a Talk node",
      params: { enabled: true },
      webchat: true,
      connectedTalkNode: false,
      errorCode: "UNAVAILABLE",
    },
    {
      name: "invalid mode parameters",
      params: { enabled: "yes" },
      webchat: false,
      connectedTalkNode: false,
      errorCode: "INVALID_REQUEST",
    },
  ])("handles Talk mode for $name without loading speech synthesis", async (testCase) => {
    const { coreGatewayHandlers } = await import("../server-methods.js");
    const respond = vi.fn();
    const broadcast = vi.fn();
    await expectDefined(
      coreGatewayHandlers["talk.mode"],
      "talk.mode lazy handler",
    )({
      req: { type: "req", id: "talk-mode-light-family", method: "talk.mode" },
      params: testCase.params,
      respond,
      context: {
        broadcast,
        hasConnectedTalkNode: async () => testCase.connectedTalkNode,
      } as never,
      client: { connect: {} } as never,
      isWebchatConnect: () => testCase.webchat,
    });

    if (testCase.errorCode) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: testCase.errorCode }),
      );
      expect(broadcast).not.toHaveBeenCalled();
    } else {
      const payload = {
        enabled: testCase.params.enabled,
        phase: testCase.params.phase ?? null,
        ts: expect.any(Number),
      };
      expect(respond).toHaveBeenCalledWith(true, payload, undefined);
      expect(broadcast).toHaveBeenCalledWith("talk.mode", payload, { dropIfSlow: true });
    }
  });

  it("dispatches cancellation without importing unrelated chat workflows", async () => {
    const { coreGatewayHandlers } = await import("../server-methods.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers["chat.abort"],
      "chat.abort lazy handler",
    )({
      req: { type: "req", id: "abort-light-family", method: "chat.abort" },
      params: { sessionKey: 42 },
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("loads agent identity without importing the agent run stack", async () => {
    const { coreGatewayHandlers } = await import("../server-methods.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers["agent.identity.get"],
      "agent.identity.get lazy handler",
    )({
      req: { type: "req", id: "identity-light-family", method: "agent.identity.get" },
      params: { agentId: "main" },
      respond,
      context: { getRuntimeConfig: () => ({}) } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ agentId: "main" }),
      undefined,
    );
    expect(runStackLoaded).not.toHaveBeenCalled();
  });

  it("loads session reads without importing the session create stack", async () => {
    const { coreGatewayHandlers } = await import("../server-methods.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers["sessions.list"],
      "sessions.list lazy handler",
    )({
      req: { type: "req", id: "sessions-read-family", method: "sessions.list" },
      params: { limit: "invalid" },
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(sessionCreateStackLoaded).not.toHaveBeenCalled();
  });
});
