import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { RecordInboundSession } from "../channels/session.types.js";
import type {
  AssembledChannelTurn,
  ChannelTurnResult,
  PreparedChannelTurn,
} from "../channels/turn/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  dispatchChannelInboundReply,
  dispatchChannelInboundTurn,
  runPreparedInboundReply,
} from "./channel-inbound.js";
import {
  deliverInboundReplyWithMessageSendContext,
  dispatchChannelInboundReply as dispatchChannelInboundReplyFromLegacySubpath,
  dispatchInboundReplyWithBase,
  hasFinalInboundReplyDispatch,
  hasVisibleInboundReplyDispatch,
  recordChannelBotPairLoopAndCheckSuppression,
  recordDroppedChannelInboundHistory,
  recordDroppedChannelTurnHistory,
  resolveInboundReplyDispatchCounts,
  runChannelInboundEvent,
  runPreparedInboundReply as runPreparedInboundReplyFromLegacySubpath,
  type AssembledInboundReply,
  type ChannelBotLoopProtectionFacts,
  type ChannelInboundDroppedHistoryOptions,
  type ChannelInboundEventRunnerParams,
  type ChannelTurnDroppedHistoryOptions,
  type ChannelTurnRecordOptions,
  type DurableInboundReplyDeliveryParams,
  type InboundReplyDispatchResult,
  type InboundReplyRecordOptions,
  type PreparedInboundReply,
} from "./inbound-reply-dispatch.js";

describe("inbound reply dispatch compatibility", () => {
  it("keeps the deprecated package subpath compatibility exports", () => {
    const callableExports = [
      ["hasFinalInboundReplyDispatch", hasFinalInboundReplyDispatch],
      ["hasVisibleInboundReplyDispatch", hasVisibleInboundReplyDispatch],
      ["resolveInboundReplyDispatchCounts", resolveInboundReplyDispatchCounts],
      ["recordDroppedChannelTurnHistory", recordDroppedChannelTurnHistory],
      ["recordDroppedChannelInboundHistory", recordDroppedChannelInboundHistory],
      ["recordChannelBotPairLoopAndCheckSuppression", recordChannelBotPairLoopAndCheckSuppression],
      ["deliverInboundReplyWithMessageSendContext", deliverInboundReplyWithMessageSendContext],
      ["dispatchInboundReplyWithBase", dispatchInboundReplyWithBase],
      ["runPreparedInboundReply", runPreparedInboundReplyFromLegacySubpath],
      ["runChannelInboundEvent", runChannelInboundEvent],
      ["dispatchChannelInboundReply", dispatchChannelInboundReplyFromLegacySubpath],
    ] as const;

    for (const [exportName, exportedValue] of callableExports) {
      expect(exportedValue, exportName).toBeTypeOf("function");
    }

    type LegacyTypeExports = [
      AssembledInboundReply,
      ChannelBotLoopProtectionFacts,
      ChannelInboundDroppedHistoryOptions,
      ChannelInboundEventRunnerParams<unknown>,
      ChannelTurnDroppedHistoryOptions,
      ChannelTurnRecordOptions,
      DurableInboundReplyDeliveryParams,
      InboundReplyDispatchResult<unknown>,
      InboundReplyRecordOptions,
      PreparedInboundReply<unknown>,
    ];
    expectTypeOf<LegacyTypeExports>().not.toBeNever();
  });

  it("keeps public channel-inbound entry points drop-capable", () => {
    type DispatchResult = { queuedFinal: true };
    const prepared = {} as PreparedChannelTurn<DispatchResult>;
    const assembled = {} as AssembledChannelTurn;

    if (Date.now() < 0) {
      expectTypeOf(runPreparedInboundReply(prepared)).toEqualTypeOf<
        Promise<ChannelTurnResult<DispatchResult>>
      >();
      expectTypeOf(dispatchChannelInboundReply(assembled)).toEqualTypeOf<
        Promise<ChannelTurnResult>
      >();
      expectTypeOf(dispatchChannelInboundTurn({} as never)).toEqualTypeOf<
        Promise<ChannelTurnResult>
      >();
    }
  });

  it("records and dispatches through dispatchInboundReplyWithBase", async () => {
    const recordInboundSession = vi.fn(async () => undefined) as unknown as RecordInboundSession;
    const deliver = vi.fn(async () => undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver(
        { text: "hello", mediaUrls: ["https://example.com/a.png"] },
        { kind: "final" },
      );
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;
    const ctxPayload = {
      Body: "body",
      RawBody: "body",
      CommandBody: "body",
      From: "sender",
      To: "target",
      SessionKey: "agent:main:test:peer",
      Provider: "test",
      Surface: "test",
    } as FinalizedMsgContext;

    await dispatchInboundReplyWithBase({
      cfg: {} as OpenClawConfig,
      channel: "test",
      accountId: "default",
      route: { agentId: "main", sessionKey: "agent:main:test:peer" },
      storePath: "/tmp/sessions.json",
      ctxPayload,
      core: {
        channel: {
          session: { recordInboundSession },
          reply: { dispatchReplyWithBufferedBlockDispatcher },
        },
      },
      deliver,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    expect(recordInboundSession).toHaveBeenCalledOnce();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith({
      text: "hello",
      mediaUrls: ["https://example.com/a.png"],
      mediaUrl: undefined,
      sensitiveMedia: undefined,
      replyToId: undefined,
    });
  });
});
