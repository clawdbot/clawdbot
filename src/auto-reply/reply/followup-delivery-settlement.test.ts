import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { deliverFollowupDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";

const deliveryState = vi.hoisted(() => ({
  followupRoute: undefined as { route: "dispatcher" | "origin" } | undefined,
  routeReply: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => deliveryState.followupRoute,
  }),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => channel === "discord" || channel === "slack",
  routeReply: (...args: unknown[]) => deliveryState.routeReply(...args),
}));

function createTurn(messageProvider = "discord"): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued",
      enqueuedAt: 1,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider,
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
}

function createDefaults(params: {
  onBlockReply?: (payload: ReplyPayload) => Promise<void>;
  settle?: (payload: ReplyPayload) => Promise<boolean>;
}) {
  return {
    defaultModel: "claude",
    typingMode: "never" as const,
    typing: {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => false),
      markRunComplete: vi.fn(),
      markDispatchIdle: vi.fn(),
      cleanup: vi.fn(),
    },
    opts: {
      onBlockReply: params.onBlockReply,
      settleBlockReplyDelivery: params.settle,
    },
  };
}

afterEach(() => {
  deliveryState.followupRoute = undefined;
  deliveryState.routeReply.mockReset();
});

describe("follow-up delivery settlement", () => {
  it("does not treat void dispatcher admission as visible delivery", async () => {
    const onBlockReply = vi.fn(async () => undefined);
    deliveryState.followupRoute = { route: "dispatcher" };

    const visible = await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "admitted only" }] },
      turn: createTurn(),
      defaults: createDefaults({ onBlockReply }),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(visible).toBe(false);
    expect(onBlockReply).toHaveBeenCalledWith({ text: "admitted only" });
  });

  it("settles every dispatcher payload after an earlier visible delivery", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    const settle = vi
      .fn<(payload: ReplyPayload) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    deliveryState.followupRoute = { route: "dispatcher" };

    const visible = await deliverFollowupDecision({
      decision: {
        kind: "deliver",
        payloads: [{ text: "first" }, { text: "second" }, { text: "third" }],
      },
      turn: createTurn(),
      defaults: createDefaults({ onBlockReply, settle }),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(settle).toHaveBeenCalledTimes(3);
    expect(visible).toBe(true);
  });

  it("propagates a later dispatcher rejection after an earlier visible delivery", async () => {
    const onBlockReply = vi
      .fn<(payload: ReplyPayload) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("later callback failed"));
    deliveryState.followupRoute = { route: "dispatcher" };

    await expect(
      deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "first" }, { text: "second" }] },
        turn: createTurn(),
        defaults: createDefaults({ onBlockReply, settle: vi.fn(async () => true) }),
        runId: "run-1",
        runFollowup: vi.fn(async () => {}),
      }),
    ).rejects.toThrow("later callback failed");
    expect(onBlockReply).toHaveBeenCalledTimes(2);
  });

  it("settles every same-channel recovery after an earlier visible recovery", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    const settle = vi
      .fn<(payload: ReplyPayload) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    deliveryState.routeReply.mockResolvedValue({ ok: false, delivered: false, error: "offline" });

    const visible = await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "first" }, { text: "second" }] },
      turn: createTurn("discord"),
      defaults: createDefaults({ onBlockReply, settle }),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual(["first", "second"]);
    expect(visible).toBe(true);
  });

  it("settles a cross-channel diagnostic after an earlier visible dispatcher payload", async () => {
    const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
      if (payload.text === "first") {
        deliveryState.followupRoute = { route: "origin" };
      }
    });
    const settle = vi.fn(async (payload: ReplyPayload) => payload.text === "first");
    deliveryState.followupRoute = { route: "dispatcher" };
    deliveryState.routeReply.mockResolvedValue({ ok: false, delivered: false, error: "offline" });

    const visible = await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "first" }, { text: "private" }] },
      turn: createTurn("slack"),
      defaults: createDefaults({ onBlockReply, settle }),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]?.[0].text).toContain("could not deliver");
    expect(visible).toBe(true);
  });
});
