// Proves follow-up batch ownership through the real channel route and durable-send boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { deliverFollowupDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";

const channelState = vi.hoisted(() => ({
  outcomes: [] as Array<"delivered" | "failed">,
  deliver: vi.fn(),
}));

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => undefined,
  }),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: (...args: unknown[]) => channelState.deliver(...args),
}));

function createChannelPlugin(id: ChannelPlugin["id"]): ChannelPlugin {
  return createChannelTestPluginBase({
    id,
    label: String(id),
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  });
}

function createTurn(params: {
  messageProvider: string;
  originatingChannel: string;
}): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued",
      enqueuedAt: 1,
      originatingChannel: params.originatingChannel,
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
        messageProvider: params.messageProvider,
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: {} as OpenClawConfig,
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

function createDefaults(onBlockReply: (payload: ReplyPayload) => Promise<void>) {
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
    opts: { onBlockReply },
  };
}

async function deliverBatch(params: {
  messageProvider: string;
  originatingChannel: string;
  outcomes: Array<"delivered" | "failed">;
  payloads: ReplyPayload[];
}) {
  channelState.outcomes = [...params.outcomes];
  const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
  await deliverFollowupDecision({
    decision: { kind: "deliver", payloads: params.payloads },
    turn: createTurn(params),
    defaults: createDefaults(onBlockReply),
    runId: "run-1",
    runFollowup: vi.fn(async () => {}),
  });
  return onBlockReply;
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry(
      (["discord", "imessage", "slack"] as const).map((id) => ({
        pluginId: id,
        plugin: createChannelPlugin(id),
        source: "test",
      })),
    ),
  );
  channelState.outcomes = [];
  channelState.deliver.mockReset();
  channelState.deliver.mockImplementation(async (params: { channel: string }) => {
    const outcome = channelState.outcomes.shift();
    if (outcome === "delivered") {
      return [{ channel: params.channel, messageId: `message-${channelState.outcomes.length}` }];
    }
    throw new Error("simulated channel delivery failure");
  });
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
});

describe("follow-up delivery channel boundary", () => {
  it("emits one safe cross-channel error when a terminal payload fails after status delivery", async () => {
    const onBlockReply = await deliverBatch({
      messageProvider: "discord",
      originatingChannel: "slack",
      outcomes: ["delivered", "failed"],
      payloads: [
        { text: "status delivered", isStatusNotice: true },
        setReplyPayloadMetadata(
          { text: "private terminal reply" },
          { assistantTranscriptOwned: true },
        ),
      ],
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ isError: true });
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toContain("could not deliver");
    expect(onBlockReply.mock.calls[0]?.[0]?.text).not.toContain("private terminal reply");
  });

  it("keeps a delivered terminal valid when a later TTS supplement fails", async () => {
    const onBlockReply = await deliverBatch({
      messageProvider: "discord",
      originatingChannel: "slack",
      outcomes: ["delivered", "failed"],
      payloads: [
        { text: "terminal reply" },
        {
          mediaUrl: "file:///tmp/terminal.mp3",
          ttsSupplement: { spokenText: "terminal reply", visibleTextAlreadyDelivered: true },
        },
      ],
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("emits one safe error when every supplemental origin delivery fails", async () => {
    const onBlockReply = await deliverBatch({
      messageProvider: "discord",
      originatingChannel: "slack",
      outcomes: ["failed", "failed"],
      payloads: [
        { text: "status one", isStatusNotice: true },
        { text: "status two", isFallbackNotice: true },
      ],
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toContain("could not deliver");
  });

  it("returns only the failed payload through same-channel recovery", async () => {
    const failedFinal = { text: "same-channel final" };
    const onBlockReply = await deliverBatch({
      messageProvider: "slack",
      originatingChannel: "slack",
      outcomes: ["delivered", "failed"],
      payloads: [{ text: "status", isStatusNotice: true }, failedFinal],
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith(failedFinal);
  });

  it("keeps alias-equivalent built-in channels on same-channel recovery", async () => {
    const failedFinal = { text: "alias same-channel final" };
    const onBlockReply = await deliverBatch({
      messageProvider: "imessage",
      originatingChannel: "imsg",
      outcomes: ["failed"],
      payloads: [failedFinal],
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith(failedFinal);
  });
});
