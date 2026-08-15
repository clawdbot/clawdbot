/**
 * Nonexistent-target-session-delivery race contract.
 *
 * Pins the continue_delegate return-delivery substrate against the P0 contract
 * for deleted/nonexistent target sessions:
 *
 *   When continue_delegate is invoked with `targetSessionKey` pointing at a
 *   session that has been deleted, never existed, or was deleted mid-dispatch,
 *   the delivery substrate must:
 *     1. Not panic.
 *     2. Surface a clean signal (success enqueue against a durable queue, or
 *        a propagated error — never silent-success masking a swallowed throw).
 *     3. Leave no orphan in-flight state past the call.
 *     4. Behave identically for cold-start vs deleted-before-dispatch targets
 *        (the substrate is sessionless by design — durability covers the
 *        late-materialization case).
 *
 * Test target: `enqueueContinuationReturnDeliveries` (targeting.ts) — the
 * single point where return-delivery hits the durable queue + in-memory
 * system-event bus + heartbeat wake. Race is modeled by mocking the deps
 * directly; existing pattern matches cross-session-targeting.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetContinuationTracer,
  setContinuationTracer,
  type Span,
  type StartSpanOptions,
  type Tracer,
} from "../../infra/continuation-tracer.js";
import type { QueuedSessionDeliveryPayload } from "../../infra/session-delivery-queue-storage.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { enqueueContinuationReturnDeliveries } from "./targeting.js";

type EnqueueSystemEvent = typeof import("../../infra/system-events.js").enqueueSystemEventRaw;

const NEVER_EXISTED = "agent:main:never-existed-session-key";
const DELETED_BEFORE = "agent:main:deleted-before-dispatch";
const DELETED_DURING = "agent:main:deleted-during-dispatch";
const EXISTING_TARGET = "agent:main:existing-target";

const noopSpan: Span = {
  setAttributes: () => undefined,
  setStatus: () => undefined,
  recordException: () => undefined,
  end: () => undefined,
};
const recordingTracer: Tracer = {
  startSpan: (_name: string, _opts?: StartSpanOptions): Span => noopSpan,
  formatTraceparent: () => undefined,
};

beforeEach(() => {
  setContinuationTracer(recordingTracer);
});

afterEach(() => {
  resetContinuationTracer();
  resetSystemEventsForTest();
});

describe("branch 1 — target session never existed (cold-start)", () => {
  it("enqueues a return delivery without throwing, even though the target was never registered", async () => {
    const enqueued: QueuedSessionDeliveryPayload[] = [];
    const systemEvents: Array<{ text: string; sessionKey: string }> = [];
    const enqueueSessionDelivery = vi.fn(async (payload: QueuedSessionDeliveryPayload) => {
      enqueued.push(payload);
      return `delivery-${enqueued.length}`;
    });
    const ackSessionDelivery = vi.fn(async () => undefined);
    const enqueueSystemEvent = vi.fn<EnqueueSystemEvent>((text, opts) => {
      systemEvents.push({ text, sessionKey: opts.sessionKey });
      return true;
    });
    const requestHeartbeatNow = vi.fn();

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: [NEVER_EXISTED],
        text: "[continuation:enrichment-return] cold-start delivery",
        idempotencyKeyBase: "continuation-return:nonexistent-cold-start",
        wakeRecipients: true,
        childRunId: "run-cold-start",
      },
      { enqueueSessionDelivery, ackSessionDelivery, enqueueSystemEvent, requestHeartbeatNow },
    );

    // Substrate guarantees no panic and a clean structural return — the durable
    // path persists the payload so a session materializing later can drain it.
    expect(result).toMatchObject({ enqueued: 1, delivered: 1 });
    expect(result.deliveryIds).toEqual(["delivery-1"]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ kind: "systemEvent", sessionKey: NEVER_EXISTED });
    expect(systemEvents).toEqual([
      { text: "[continuation:enrichment-return] cold-start delivery", sessionKey: NEVER_EXISTED },
    ]);
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
    // No ack on the durable file: the queue must persist so the recovery loop
    // can replay if the target session materializes on the next gateway boot.
    expect(ackSessionDelivery).not.toHaveBeenCalled();
  });

  it("returns deliveryIds matching the input targets one-to-one with no extra in-flight state", async () => {
    const enqueueSessionDelivery = vi.fn(async () => "delivery-cold-N");
    const ackSessionDelivery = vi.fn(async () => undefined);
    const enqueueSystemEvent = vi.fn<EnqueueSystemEvent>(() => true);
    const requestHeartbeatNow = vi.fn();

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: [NEVER_EXISTED, `${NEVER_EXISTED}-2`],
        text: "[continuation:enrichment-return] cold-start fanout",
        idempotencyKeyBase: "continuation-return:cold-start-fanout",
      },
      { enqueueSessionDelivery, ackSessionDelivery, enqueueSystemEvent, requestHeartbeatNow },
    );

    expect(result.enqueued).toBe(2);
    expect(result.delivered).toBe(2);
    expect(result.deliveryIds).toHaveLength(2);
    expect(enqueueSessionDelivery).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
    // wakeRecipients omitted → heartbeat must not fire.
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });
});

describe("branch 2 — target session deleted before dispatch", () => {
  it("delivers identically whether the target was deleted-before or never-existed (sessionless substrate)", async () => {
    const enqueueSessionDelivery = vi.fn(async () => "delivery-deleted-before");
    const ackSessionDelivery = vi.fn(async () => undefined);
    const enqueueSystemEvent = vi.fn<EnqueueSystemEvent>(() => true);
    const requestHeartbeatNow = vi.fn();

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: [DELETED_BEFORE],
        text: "[continuation:enrichment-return] deleted-before delivery",
        idempotencyKeyBase: "continuation-return:deleted-before",
        wakeRecipients: true,
        childRunId: "run-deleted-before",
      },
      { enqueueSessionDelivery, ackSessionDelivery, enqueueSystemEvent, requestHeartbeatNow },
    );

    expect(result).toMatchObject({ enqueued: 1, delivered: 1 });
    expect(enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(ackSessionDelivery).not.toHaveBeenCalled();
  });

  it("does not call enqueueSystemEvent when the prior enqueue throws (no half-write into the in-memory bus)", async () => {
    const enqueueSessionDelivery = vi.fn(async () => {
      throw new Error("ENOENT: durable queue dir vanished mid-call");
    });
    const ackSessionDelivery = vi.fn(async () => undefined);
    const enqueueSystemEvent = vi.fn<EnqueueSystemEvent>(() => true);
    const requestHeartbeatNow = vi.fn();

    await expect(
      enqueueContinuationReturnDeliveries(
        {
          targetSessionKeys: [DELETED_BEFORE],
          text: "[continuation:enrichment-return] enqueue fails",
          idempotencyKeyBase: "continuation-return:enqueue-fail",
        },
        { enqueueSessionDelivery, ackSessionDelivery, enqueueSystemEvent, requestHeartbeatNow },
      ),
    ).rejects.toThrow("ENOENT: durable queue dir vanished mid-call");

    // Substrate must not have written to the in-memory bus before the durable
    // enqueue succeeded — that would be a silent half-state where memory
    // claims delivery but the durable file never landed.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(ackSessionDelivery).not.toHaveBeenCalled();
  });
});

describe("branch 3 — target deleted during dispatch race", () => {
  it("propagates the underlying error as clean-error rather than panicking when a mid-loop dep throws", async () => {
    let call = 0;
    const enqueueSessionDelivery = vi.fn(async (payload: QueuedSessionDeliveryPayload) => {
      call += 1;
      if (payload.sessionKey === DELETED_DURING) {
        throw new Error("ENOENT: session-delivery file deleted during race");
      }
      return `delivery-${call}`;
    });
    const ackSessionDelivery = vi.fn(async () => undefined);
    const enqueueSystemEvent = vi.fn<EnqueueSystemEvent>(() => true);
    const requestHeartbeatNow = vi.fn();

    await expect(
      enqueueContinuationReturnDeliveries(
        {
          targetSessionKeys: [EXISTING_TARGET, DELETED_DURING, `${EXISTING_TARGET}-2`],
          text: "[continuation:enrichment-return] race fanout",
          idempotencyKeyBase: "continuation-return:race",
          wakeRecipients: true,
        },
        { enqueueSessionDelivery, ackSessionDelivery, enqueueSystemEvent, requestHeartbeatNow },
      ),
    ).rejects.toThrow("ENOENT: session-delivery file deleted during race");

    // Pre-race target delivered cleanly; the post-race target was never reached
    // and never half-wrote to the in-memory bus. No orphan ack issued.
    expect(enqueueSessionDelivery).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "[continuation:enrichment-return] race fanout",
      expect.objectContaining({ sessionKey: EXISTING_TARGET }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: EXISTING_TARGET, reason: "delegate-return" }),
    );
    expect(ackSessionDelivery).not.toHaveBeenCalled();
  });

  it("delivers all targets when the race resolves with no dep failure (success-pre-delete shape)", async () => {
    // Same call shape as the failing race, except no dep throws. The substrate
    // must reach `delivered === N` and never leave a partial-write window.
    const enqueueSessionDelivery = vi.fn(async () => "delivery-race-ok");
    const ackSessionDelivery = vi.fn(async () => undefined);
    const enqueueSystemEvent = vi.fn<EnqueueSystemEvent>(() => true);
    const requestHeartbeatNow = vi.fn();

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: [EXISTING_TARGET, DELETED_DURING, `${EXISTING_TARGET}-2`],
        text: "[continuation:enrichment-return] race resolved pre-delete",
        idempotencyKeyBase: "continuation-return:race-ok",
        wakeRecipients: true,
      },
      { enqueueSessionDelivery, ackSessionDelivery, enqueueSystemEvent, requestHeartbeatNow },
    );

    expect(result).toMatchObject({ enqueued: 3, delivered: 3 });
    expect(enqueueSessionDelivery).toHaveBeenCalledTimes(3);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(3);
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(3);
  });
});

describe("branch 4 — happy-path control (sanity-check the mock harness)", () => {
  it("delivers cleanly to an existing target session through the same substrate", async () => {
    const enqueued: QueuedSessionDeliveryPayload[] = [];
    const systemEvents: Array<{ text: string; sessionKey: string }> = [];
    const enqueueSessionDelivery = vi.fn(async (payload: QueuedSessionDeliveryPayload) => {
      enqueued.push(payload);
      return `delivery-happy-${enqueued.length}`;
    });
    const ackSessionDelivery = vi.fn(async () => undefined);
    const enqueueSystemEvent = vi.fn<EnqueueSystemEvent>((text, opts) => {
      systemEvents.push({ text, sessionKey: opts.sessionKey });
      return true;
    });
    const requestHeartbeatNow = vi.fn();

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: [EXISTING_TARGET],
        text: "[continuation:enrichment-return] happy path",
        idempotencyKeyBase: "continuation-return:happy",
        wakeRecipients: true,
        childRunId: "run-happy",
      },
      { enqueueSessionDelivery, ackSessionDelivery, enqueueSystemEvent, requestHeartbeatNow },
    );

    expect(result).toMatchObject({ enqueued: 1, delivered: 1 });
    expect(enqueued).toEqual([
      expect.objectContaining({
        kind: "systemEvent",
        sessionKey: EXISTING_TARGET,
        text: "[continuation:enrichment-return] happy path",
      }),
    ]);
    expect(systemEvents).toEqual([
      { text: "[continuation:enrichment-return] happy path", sessionKey: EXISTING_TARGET },
    ]);
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: EXISTING_TARGET, reason: "delegate-return" }),
    );
    expect(ackSessionDelivery).not.toHaveBeenCalled();
  });
});
