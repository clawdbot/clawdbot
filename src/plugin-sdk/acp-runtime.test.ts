import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";

const { bypassMock, dispatchMock } = vi.hoisted(() => ({
  bypassMock: vi.fn(),
  dispatchMock: vi.fn(),
}));

vi.mock("../auto-reply/reply/dispatch-acp.runtime.js", () => ({
  shouldBypassAcpDispatchForCommand: bypassMock,
  tryDispatchAcpReply: dispatchMock,
}));

import { tryDispatchAcpReplyHook } from "./acp-runtime.js";

const event = {
  ctx: buildTestCtx({
    SessionKey: "agent:test:session",
    CommandBody: "/acp cancel",
    BodyForCommands: "/acp cancel",
    BodyForAgent: "/acp cancel",
  }),
  runId: "run-1",
  sessionKey: "agent:test:session",
  inboundAudio: false,
  sessionTtsAuto: "off" as const,
  ttsChannel: undefined,
  suppressUserDelivery: false,
  shouldRouteToOriginating: false,
  originatingChannel: undefined,
  originatingTo: undefined,
  shouldSendToolSummaries: true,
  sendPolicy: "allow" as const,
};

const ctx = {
  cfg: {},
  dispatcher: {
    sendToolResult: () => false,
    sendBlockReply: () => false,
    sendFinalReply: () => false,
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
  },
  abortSignal: undefined,
  onReplyStart: undefined,
  recordProcessed: vi.fn(),
  markIdle: vi.fn(),
};

function expectDispatchPayloadFields(expected: Record<string, unknown>): void {
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  const [payload] = dispatchMock.mock.calls[0] ?? [];
  expect(payload).toBeTypeOf("object");
  for (const [key, value] of Object.entries(expected)) {
    expect((payload as Record<string, unknown>)[key]).toBe(value);
  }
}

describe("tryDispatchAcpReplyHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips ACP runtime lookup for plain-text deny turns", async () => {
    const result = await tryDispatchAcpReplyHook(
      {
        ...event,
        sendPolicy: "deny",
        ctx: buildTestCtx({
          SessionKey: "agent:test:session",
          BodyForCommands: "write a test",
          BodyForAgent: "write a test",
        }),
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(bypassMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("skips ACP dispatch when send policy denies delivery and no bypass applies", async () => {
    bypassMock.mockResolvedValue(false);

    const result = await tryDispatchAcpReplyHook({ ...event, sendPolicy: "deny" }, ctx);

    expect(result).toBeUndefined();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("dispatches through ACP when command bypass applies", async () => {
    bypassMock.mockResolvedValue(true);
    dispatchMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });

    const result = await tryDispatchAcpReplyHook({ ...event, sendPolicy: "deny" }, ctx);

    expect(result).toEqual({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });
    expectDispatchPayloadFields({
      ctx: event.ctx,
      cfg: ctx.cfg,
      dispatcher: ctx.dispatcher,
      bypassForCommand: true,
    });
  });

  it("returns unhandled when ACP dispatcher declines the turn", async () => {
    bypassMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue(undefined);

    const result = await tryDispatchAcpReplyHook(event, ctx);

    expect(result).toBeUndefined();
    expect(dispatchMock).toHaveBeenCalledOnce();
  });

  it("dispatches non-tail ACP turn under deny when suppressUserDelivery is set", async () => {
    bypassMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });

    const result = await tryDispatchAcpReplyHook(
      {
        ...event,
        sendPolicy: "deny",
        suppressUserDelivery: true,
        ctx: buildTestCtx({
          SessionKey: "agent:test:session",
          BodyForCommands: "write a test",
          BodyForAgent: "write a test",
        }),
      },
      ctx,
    );

    // Non-tail, non-command ACP turns under deny must still flow through ACP
    // runtime so session/tool state stays consistent — delivery suppression is
    // handled inside the ACP delivery path via suppressUserDelivery.
    expectDispatchPayloadFields({
      suppressUserDelivery: true,
      suppressReplyLifecycle: true,
      bypassForCommand: false,
    });
    expect(result).toEqual({
      handled: true,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
  });

  it("allows tail dispatch through when sendPolicy is deny", async () => {
    bypassMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });

    const result = await tryDispatchAcpReplyHook(
      {
        ...event,
        sendPolicy: "deny",
        isTailDispatch: true,
        ctx: buildTestCtx({
          SessionKey: "agent:test:session",
          BodyForCommands: "continue after reset",
          BodyForAgent: "continue after reset",
        }),
      },
      ctx,
    );

    // Tail dispatch should proceed despite deny — delivery suppression is handled downstream
    expect(dispatchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      handled: true,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
  });

  it("does not let ACP claim reset commands before local command handling", async () => {
    bypassMock.mockResolvedValue(true);
    dispatchMock.mockResolvedValue(undefined);

    const result = await tryDispatchAcpReplyHook(
      {
        ...event,
        ctx: buildTestCtx({
          SessionKey: "agent:test:session",
          CommandBody: "/new",
          BodyForCommands: "/new",
          BodyForAgent: "/new",
        }),
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expectDispatchPayloadFields({
      bypassForCommand: true,
    });
  });
});
