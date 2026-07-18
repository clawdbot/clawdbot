import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedSessionDeliveryPayload } from "../../infra/session-delivery-queue-storage.js";
import {
  ackSessionDelivery as realAckSessionDelivery,
  enqueueSessionDelivery as realEnqueueSessionDelivery,
  loadPendingSessionDeliveries,
} from "../../infra/session-delivery-queue-storage.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { drainFormattedSystemEvents } from "../reply/session-system-events.js";
import {
  hasCrossSessionDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting-pure.js";
import {
  enqueueContinuationReturnDeliveries,
  resolveContinuationReturnTargetSessionKeys,
} from "./targeting.js";

describe("nonexistent-target-session: normalization pre-guards (targeting-pure)", () => {
  describe("normalizeContinuationTargetKey", () => {
    it.each([
      { label: "undefined", value: undefined },
      { label: "empty string", value: "" },
      { label: "whitespace-only", value: "   " },
    ])("normalizes $label to undefined", ({ value }) => {
      expect(normalizeContinuationTargetKey(value)).toBeUndefined();
    });

    it("passes through a valid-but-nonexistent session key unchanged", () => {
      expect(normalizeContinuationTargetKey("agent:main:never-existed")).toBe(
        "agent:main:never-existed",
      );
    });
  });

  describe("normalizeContinuationTargetKeys", () => {
    it("filters out undefined/empty/whitespace keys and returns only valid ones", () => {
      expect(
        normalizeContinuationTargetKeys([
          undefined as unknown as string,
          "",
          "   ",
          "agent:main:ghost",
          "agent:main:phantom",
        ]),
      ).toEqual(["agent:main:ghost", "agent:main:phantom"]);
    });

    it("returns empty array when all keys are empty/undefined", () => {
      expect(normalizeContinuationTargetKeys([undefined as unknown as string, "", "  "])).toEqual(
        [],
      );
    });

    it("returns empty array for undefined input", () => {
      expect(normalizeContinuationTargetKeys(undefined)).toEqual([]);
    });
  });

  describe("hasCrossSessionDelegateTargeting", () => {
    const dispatchingSessionKey = "agent:main:dispatcher";
    const emptyDispatchingSessionKey = "";

    it.each([
      { label: "undefined targetSessionKey", targeting: { targetSessionKey: undefined } },
      { label: "empty targetSessionKey", targeting: { targetSessionKey: "" } },
      { label: "whitespace targetSessionKey", targeting: { targetSessionKey: "   " } },
    ])("returns false for $label (no cross-session)", ({ targeting }) => {
      expect(hasCrossSessionDelegateTargeting(targeting, dispatchingSessionKey)).toBe(false);
    });

    it("returns true for a valid-but-nonexistent target different from dispatcher", () => {
      expect(
        hasCrossSessionDelegateTargeting(
          { targetSessionKey: "agent:main:never-existed" },
          dispatchingSessionKey,
        ),
      ).toBe(true);
    });

    it.each([
      { label: "empty targetSessionKey", targeting: { targetSessionKey: "" } },
      { label: "whitespace targetSessionKey", targeting: { targetSessionKey: "   " } },
      { label: "empty targetSessionKeys", targeting: { targetSessionKeys: [] } },
    ])("returns false through the empty-dispatcher facade for $label", ({ targeting }) => {
      expect(hasCrossSessionDelegateTargeting(targeting, emptyDispatchingSessionKey)).toBe(false);
    });

    it("returns true through the empty-dispatcher facade for a valid nonexistent target", () => {
      expect(
        hasCrossSessionDelegateTargeting(
          { targetSessionKey: "agent:main:never-existed" },
          emptyDispatchingSessionKey,
        ),
      ).toBe(true);
    });
  });
});

describe("nonexistent-target-session: return target resolution (targeting.ts)", () => {
  it("returns a nonexistent targetSessionKey as the sole target", () => {
    expect(
      resolveContinuationReturnTargetSessionKeys({
        defaultSessionKey: "agent:main:parent",
        targetSessionKey: "agent:main:never-existed",
      }),
    ).toEqual(["agent:main:never-existed"]);
  });

  it("returns nonexistent targetSessionKeys without filtering", () => {
    expect(
      resolveContinuationReturnTargetSessionKeys({
        defaultSessionKey: "agent:main:parent",
        targetSessionKeys: ["agent:main:ghost", "agent:main:phantom"],
      }),
    ).toEqual(["agent:main:ghost", "agent:main:phantom"]);
  });

  it("falls back to defaultSessionKey when targetSessionKey is undefined", () => {
    expect(
      resolveContinuationReturnTargetSessionKeys({
        defaultSessionKey: "agent:main:parent",
        targetSessionKey: undefined,
      }),
    ).toEqual(["agent:main:parent"]);
  });

  it("falls back to defaultSessionKey when targetSessionKey is empty string", () => {
    expect(
      resolveContinuationReturnTargetSessionKeys({
        defaultSessionKey: "agent:main:parent",
        targetSessionKey: "",
      }),
    ).toEqual(["agent:main:parent"]);
  });

  it("mixes nonexistent and real-looking keys without filtering", () => {
    expect(
      resolveContinuationReturnTargetSessionKeys({
        defaultSessionKey: "agent:main:parent",
        targetSessionKeys: ["agent:main:exists", "agent:main:stale-removed"],
      }),
    ).toEqual(["agent:main:exists", "agent:main:stale-removed"]);
  });
});

describe("nonexistent-target-session: delivery resilience (targeting.ts)", () => {
  type EnqueueSystemEvent = typeof import("../../infra/system-events.js").enqueueSystemEvent;

  afterEach(() => {
    resetSystemEventsForTest();
  });

  it("delivers to a nonexistent target key without throwing (mocked deps)", async () => {
    const enqueued: QueuedSessionDeliveryPayload[] = [];
    const systemEvents: Array<{ text: string; sessionKey: string }> = [];
    const enqueueSessionDelivery = vi.fn(async (payload: QueuedSessionDeliveryPayload) => {
      enqueued.push(payload);
      return `delivery-${enqueued.length}`;
    });
    const ackSessionDelivery = vi.fn(async () => undefined);
    const mockEnqueueSystemEvent = vi.fn<EnqueueSystemEvent>((text, opts) => {
      systemEvents.push({ text, sessionKey: opts.sessionKey });
      return true;
    });
    const requestHeartbeatNow = vi.fn();

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: ["agent:main:never-existed"],
        text: "[continuation:enrichment-return] nonexistent target",
        idempotencyKeyBase: "continuation-return:nonexistent-test",
        wakeRecipients: true,
        childRunId: "run-nonexistent",
      },
      {
        enqueueSessionDelivery,
        ackSessionDelivery,
        enqueueSystemEvent: mockEnqueueSystemEvent,
        requestHeartbeatNow,
      },
    );

    expect(result).toMatchObject({ enqueued: 1, delivered: 1 });
    expect(result.deliveryIds).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    const delivery = expectDefined(enqueued.at(0), "enqueued delivery");
    expect(delivery.sessionKey).toBe("agent:main:never-existed");
    expect(delivery.kind).toBe("systemEvent");
    expect(systemEvents).toEqual([
      {
        text: "[continuation:enrichment-return] nonexistent target",
        sessionKey: "agent:main:never-existed",
      },
    ]);
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(ackSessionDelivery).not.toHaveBeenCalled();
  });

  it("delivers to multiple nonexistent targets, all complete gracefully", async () => {
    const enqueued: QueuedSessionDeliveryPayload[] = [];
    const enqueueSessionDelivery = vi.fn(async (payload: QueuedSessionDeliveryPayload) => {
      enqueued.push(payload);
      return `delivery-${enqueued.length}`;
    });
    const requestHeartbeatNow = vi.fn();

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: ["agent:main:ghost", "agent:main:phantom", "agent:main:stale"],
        text: "[continuation:enrichment-return] multi nonexistent",
        idempotencyKeyBase: "continuation-return:multi-nonexistent",
        wakeRecipients: true,
        childRunId: "run-multi-nonexistent",
      },
      {
        enqueueSessionDelivery,
        ackSessionDelivery: vi.fn(async () => undefined),
        enqueueSystemEvent: vi.fn<EnqueueSystemEvent>(() => true),
        requestHeartbeatNow,
      },
    );

    expect(result).toMatchObject({ enqueued: 3, delivered: 3 });
    expect(result.deliveryIds).toHaveLength(3);
    expect(enqueued.map((p) => p.sessionKey)).toEqual([
      "agent:main:ghost",
      "agent:main:phantom",
      "agent:main:stale",
    ]);
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(3);
  });

  it("returns zero enqueued/delivered when all target keys normalize to empty", async () => {
    const enqueueSessionDelivery = vi.fn(async () => "delivery-id");
    const requestHeartbeatNow = vi.fn();

    const targetSessionKeys = resolveContinuationReturnTargetSessionKeys({
      defaultSessionKey: "",
      targetSessionKey: "",
    });
    expect(targetSessionKeys).toEqual([]);

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys,
        text: "[continuation:enrichment-return] empty targets",
        idempotencyKeyBase: "continuation-return:empty-targets",
      },
      {
        enqueueSessionDelivery,
        ackSessionDelivery: vi.fn(async () => undefined),
        enqueueSystemEvent: vi.fn<EnqueueSystemEvent>(() => true),
        requestHeartbeatNow,
      },
    );

    expect(result).toMatchObject({ enqueued: 0, delivered: 0, deliveryIds: [] });
    expect(enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("persists a durable queue file for a nonexistent target (real I/O)", async () => {
    await withTempDir({ prefix: "openclaw-nonexistent-target-" }, async (stateDir) => {
      const mockEnqueueSystemEvent = vi.fn<EnqueueSystemEvent>(() => true);
      const requestHeartbeatNow = vi.fn();

      const result = await enqueueContinuationReturnDeliveries(
        {
          targetSessionKeys: ["agent:main:never-existed"],
          text: "[continuation:enrichment-return] durable nonexistent",
          idempotencyKeyBase: "continuation-return:durable-nonexistent",
          stateDir,
          wakeRecipients: true,
          childRunId: "run-durable-nonexistent",
        },
        {
          enqueueSessionDelivery: realEnqueueSessionDelivery,
          ackSessionDelivery: realAckSessionDelivery,
          enqueueSystemEvent: mockEnqueueSystemEvent,
          requestHeartbeatNow,
        },
      );

      expect(result).toMatchObject({ enqueued: 1, delivered: 1 });

      const persistedEntries = await loadPendingSessionDeliveries(stateDir);
      expect(persistedEntries).toHaveLength(1);

      const persisted = expectDefined(persistedEntries.at(0), "persisted delivery");
      expect(persisted.kind).toBe("systemEvent");
      expect(persisted.sessionKey).toBe("agent:main:never-existed");
    });
  });

  it("enqueues in-memory system event for a nonexistent target (real system events)", async () => {
    const enqueueSessionDelivery = vi.fn(async () => "delivery-id");
    const requestHeartbeatNow = vi.fn();

    await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: ["agent:main:never-existed"],
        text: "[continuation:enrichment-return] in-memory nonexistent",
        idempotencyKeyBase: "continuation-return:inmem-nonexistent",
        wakeRecipients: false,
      },
      {
        enqueueSessionDelivery,
        ackSessionDelivery: vi.fn(async () => undefined),
        enqueueSystemEvent,
        requestHeartbeatNow,
      },
    );

    expect(peekSystemEventEntries("agent:main:never-existed")).toHaveLength(1);
    const context = await drainFormattedSystemEvents({
      cfg: {},
      sessionKey: "agent:main:never-existed",
      isMainSession: false,
      isNewSession: false,
    });
    expect(context).toContain("System:");
    expect(context).toContain("in-memory nonexistent");
    expect(peekSystemEventEntries("agent:main:never-existed")).toEqual([]);
  });
});
