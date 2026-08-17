import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createReplyDispatcher,
  type GetReplyOptions,
  type ReplyDispatcher,
} from "./reply-runtime.js";

type ProgressResult = boolean | void;
type ProgressCallback = GetReplyOptions[
  | "onToolResult"
  | "onToolStart"
  | "onItemEvent"
  | "onPlanUpdate"
  | "onApprovalEvent"
  | "onCommandOutput"
  | "onPatchSummary"];
type ProgressBoundaryCallback = GetReplyOptions[
  | "onReasoningEnd"
  | "onAssistantMessageStart"
  | "onBlockReplyQueued"
  | "onCompactionStart"
  | "onCompactionEnd"];

describe("reply runtime public progress contracts", () => {
  it("exports acceptance-aware progress callback results", () => {
    expectTypeOf<Exclude<ProgressCallback, undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
    expectTypeOf<Exclude<GetReplyOptions["onPartialReply"], undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
    expectTypeOf<Exclude<GetReplyOptions["onReasoningStream"], undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
    expectTypeOf<Exclude<ProgressBoundaryCallback, undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
  });

  it("exports the snapshotted commentary delivery gate", () => {
    expectTypeOf<GetReplyOptions["commentaryPayloadsEnabled"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<
      Exclude<GetReplyOptions["shouldDeliverCommentaryPayloads"], undefined>
    >().returns.toEqualTypeOf<boolean>();
  });
});

describe("reply runtime public dispatcher compatibility", () => {
  it("projects deprecated counters from settled receipt outcomes", async () => {
    let releaseFirstDelivery!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    let firstDeliveryPending = true;
    const dispatcher: ReplyDispatcher = createReplyDispatcher({
      beforeDeliver: async (payload) => (payload.text === "cancel" ? null : payload),
      deliver: async (payload) => {
        if (firstDeliveryPending) {
          firstDeliveryPending = false;
          await firstDelivery;
        }
        if (payload.text === "fail") {
          throw new Error("transport failed after send started");
        }
      },
    });

    dispatcher.sendToolResult({ text: "delivered" });
    dispatcher.sendBlockReply({ text: "cancel" });
    dispatcher.sendFinalReply({ text: "fail" });

    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });

    releaseFirstDelivery();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 1, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 1, final: 0 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
  });
});
