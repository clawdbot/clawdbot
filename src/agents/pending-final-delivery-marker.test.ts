import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { persistPendingFinalDeliveryMarker } from "./pending-final-delivery-marker.js";

const state = vi.hoisted(() => ({ persistAgentSession: vi.fn() }));

vi.mock("./command/attempt-execution.shared.js", () => ({
  persistAgentSession: (...args: unknown[]) => state.persistAgentSession(...args),
}));

describe("persistPendingFinalDeliveryMarker", () => {
  beforeEach(() => {
    state.persistAgentSession
      .mockReset()
      .mockImplementation(async (params: { entry: SessionEntry }) => params.entry);
  });

  it("owns a multi-payload command delivery as one durable batch", async () => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
    const payloads = [{ text: "first" }, { text: "second" }];

    const result = await persistPendingFinalDeliveryMarker({
      deliver: true,
      sessionStore: { main: entry },
      sessionKey: "main",
      sessionEntry: entry,
      storePath: "/tmp/sessions.json",
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads,
      deliveryContext: { channel: "discord", to: "channel:c1" },
      runOwnedSessionId: "session-1",
    });

    expect(result.sessionEntry?.pendingFinalDelivery?.deliveries).toEqual([
      { id: expect.any(String), state: "prepared" },
    ]);
    const deliveryId = result.sessionEntry?.pendingFinalDelivery?.deliveries?.[0]?.id;
    expect(
      payloads.map(
        (payload) => getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion?.deliveryId,
      ),
    ).toEqual([deliveryId, deliveryId]);
  });
});
