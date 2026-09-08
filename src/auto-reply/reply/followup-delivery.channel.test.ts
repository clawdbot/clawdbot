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
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
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

function registerCurrentReplyThreading() {
  const slack = createChannelPlugin("slack");
  slack.threading = {
    resolveReplyTransport: (params: {
      threadId?: string | number | null;
      replyToId?: string | null;
      replyToCurrent?: boolean;
    }) => ({
      threadId: null,
      replyToId: params.replyToCurrent ? String(params.threadId) : params.replyToId,
    }),
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", plugin: slack, source: "test" }]),
  );
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
  it.each<{
    name: string;
    payload?: ReplyPayload;
    provenance?: AdmittedFollowupTurn["queued"]["run"]["inputProvenance"];
    sourceChannel?: string;
    targetChannel?: string;
    omitMessageId?: boolean;
    expectedReply: string | null;
  }>([
    { name: "implicit current inbound", expectedReply: "new-inbound" },
    {
      name: "explicit external provenance",
      provenance: { kind: "external_user" },
      expectedReply: "new-inbound",
    },
    {
      name: "explicit reply target",
      payload: { text: "queued answer", replyToId: "explicit-target" },
      expectedReply: "explicit-target",
    },
    {
      name: "restart sentinel",
      provenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
      expectedReply: null,
    },
    {
      name: "child announcement",
      provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      expectedReply: null,
    },
    { name: "different source channel", sourceChannel: "discord", expectedReply: null },
    { name: "another channel", targetChannel: "imessage", expectedReply: null },
    { name: "no inbound id", omitMessageId: true, expectedReply: null },
  ])("passes queued origin message facts to the channel resolver: $name", async (testCase) => {
    const source = createChannelPlugin("slack");
    source.threading = {
      resolveReplyTransport: ({ currentMessageId, replyToId }) => ({
        replyToId: replyToId ?? currentMessageId,
      }),
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", plugin: source, source: "test" },
        { pluginId: "imessage", plugin: createChannelPlugin("imessage"), source: "test" },
      ]),
    );
    const channel = testCase.targetChannel ?? "slack";
    const turn = createTurn({
      messageProvider: testCase.sourceChannel ?? channel,
      originatingChannel: channel,
    });
    turn.queued.originatingTo = "dm:qa-peer";
    turn.queued.messageId = testCase.omitMessageId ? undefined : "new-inbound";
    turn.queued.originatingChatType = "direct";
    turn.queued.run.inputProvenance = testCase.provenance;
    const payload = testCase.payload ?? { text: "queued answer" };
    channelState.outcomes = ["delivered"];
    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [payload] },
      turn,
      defaults: createDefaults(vi.fn(async () => {})),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });
    expect(channelState.deliver).toHaveBeenCalledOnce();
    expect(channelState.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        channel,
        to: "dm:qa-peer",
        replyToId: testCase.expectedReply,
      }),
    );
  });

  it.each([true, false])(
    "carries current-reply intent (%s) through queued status delivery",
    async (replyToCurrent) => {
      registerCurrentReplyThreading();
      const turn = createTurn({ messageProvider: "discord", originatingChannel: "slack" });
      turn.queued.originatingThreadId = "111.000";
      channelState.outcomes = ["delivered"];
      await deliverFollowupDecision({
        decision: {
          kind: "deliver",
          payloads: [
            {
              text: "Compacting context",
              replyToId: "222.000",
              replyToCurrent,
              isCompactionNotice: true,
            },
          ],
        },
        turn,
        defaults: createDefaults(vi.fn(async () => {})),
        runId: "run-1",
        runFollowup: vi.fn(async () => {}),
        kind: "block",
      });

      expect(channelState.deliver).toHaveBeenCalledWith(
        expect.objectContaining({ replyToId: replyToCurrent ? "111.000" : "222.000" }),
      );
    },
  );

  it("dedupes a current-reply status against its actual thread root", () => {
    registerCurrentReplyThreading();
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: {},
        payloads: [
          {
            text: "Compacting context",
            replyToId: "222.000",
            replyToCurrent: true,
            isCompactionNotice: true,
          },
        ],
        messageProvider: "slack",
        originatingChannel: "slack",
        originatingReplyToMode: "all",
        originatingTo: "channel:C1",
        originatingThreadId: "111.000",
        sentTexts: ["Compacting context"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            threadId: "111.000",
            text: "Compacting context",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("renders post-compaction model failures after queued payload selection", () => {
    const decision = resolveFollowupDeliveryDecision({
      turn: createTurn({ messageProvider: "discord", originatingChannel: "discord" }),
      execution: {
        runId: "run-1",
        outcome: {
          kind: "rejected",
          payload: { text: "⚠️ Provider billing failed.", isError: true },
          postCompactionModelFailure: true,
        },
      },
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [
        {
          text: "⚠️ Context compaction succeeded, but the later model request still failed. Provider billing failed.",
          isError: true,
        },
      ],
    });
  });

  it.each([
    { mode: "first", duplicate: "media" },
    { mode: "batched", duplicate: "media" },
    { mode: "first", duplicate: "text" },
    { mode: "batched", duplicate: "text" },
  ] as const)(
    "preserves the $mode reply slot when earlier $duplicate was already sent",
    ({ mode, duplicate }) => {
      const duplicatePayload =
        duplicate === "media"
          ? { mediaUrl: "/tmp/already-sent.png", replyToId: "parent" }
          : { text: "already sent", replyToId: "parent" };

      expect(
        resolveFollowupDeliveryPayloads({
          cfg: {},
          payloads: [duplicatePayload, { text: "actual answer", replyToId: "parent" }],
          originatingChannel: "discord",
          originatingReplyToMode: mode,
          sentMediaUrls: ["/tmp/already-sent.png"],
          sentTexts: ["already sent"],
        }),
      ).toEqual([{ text: "actual answer", replyToId: "parent" }]);
    },
  );

  it("dedupes later Slack replies against their actual first-mode transport thread", () => {
    const slack = createChannelPlugin("slack");
    slack.threading = {
      resolveReplyTransport: ({ threadId, replyToId, replyToIsExplicit }) => {
        const inheritedThread = threadId == null ? undefined : String(threadId);
        // First-mode can clear replyToId; Slack still falls back to the inherited thread.
        return {
          threadId: null,
          replyToId:
            replyToIsExplicit === false
              ? (inheritedThread ?? replyToId)
              : (replyToId ?? inheritedThread),
        };
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", plugin: slack, source: "test" }]),
    );

    expect(
      resolveFollowupDeliveryPayloads({
        cfg: {},
        payloads: [
          { text: "first answer", replyToId: "111.000" },
          { text: "already sent", replyToId: "222.000" },
        ],
        messageProvider: "slack",
        originatingChannel: "slack",
        originatingReplyToMode: "first",
        originatingTo: "channel:C1",
        originatingThreadId: "111.000",
        sentTexts: ["already sent"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            threadId: "111.000",
            text: "already sent",
          },
        ],
      }),
    ).toEqual([{ text: "first answer", replyToId: "111.000" }]);
  });

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
