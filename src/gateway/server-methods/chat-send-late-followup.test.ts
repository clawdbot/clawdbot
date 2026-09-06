import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChatSendLateFollowupDisposition } from "./chat-send-late-followup.js";

describe("chat.send late queued follow-up disposition", () => {
  it.each([
    ["discord", "discord", "non-webchat-origin"],
    ["webchat", "discord", "origin-mismatch"],
  ])("records an explicit drop for %s -> %s", async (originatingChannel, batchChannel, reason) => {
    const info = vi.fn();
    const deliver = vi.fn(async () => ({ kind: "delivered" as const }));
    const disposition = createChatSendLateFollowupDisposition({
      runId: "original-run",
      originatingChannel,
      logGateway: { info } as never,
      deliver,
    });
    disposition.recordQueued();
    await disposition.deliver({
      kind: "queued-followup",
      runId: "followup-run",
      originatingChannel: batchChannel,
      payloads: [{ text: "must not leak" }],
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "webchat late reply disposition",
      expect.objectContaining({ outcome: "late-and-dropped", reason }),
    );
  });

  it("claims delivery before awaiting and records a concurrent duplicate", async () => {
    const info = vi.fn();
    const delivery = createDeferred<{ kind: "delivered" }>();
    const deliver = vi.fn(() => delivery.promise);
    const disposition = createChatSendLateFollowupDisposition({
      runId: "original-run",
      originatingChannel: "webchat",
      logGateway: { info } as never,
      deliver,
    });
    disposition.recordQueued();
    const first = disposition.deliver({
      kind: "queued-followup",
      runId: "first-followup",
      originatingChannel: "webchat",
      payloads: [{ text: "first" }],
    });
    await disposition.deliver({
      kind: "queued-followup",
      runId: "duplicate-followup",
      originatingChannel: "webchat",
      payloads: [{ text: "duplicate" }],
    });
    expect(deliver).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "webchat late reply disposition",
      expect.objectContaining({ reason: "delivery-in-flight" }),
    );
    delivery.resolve({ kind: "delivered" });
    await first;
  });

  it("settles a failed delivery and rejects every subsequent attempt", async () => {
    const info = vi.fn();
    const deliver = vi.fn(async () => {
      throw new Error("broadcast failed");
    });
    const disposition = createChatSendLateFollowupDisposition({
      runId: "original-run",
      originatingChannel: "webchat",
      logGateway: { info } as never,
      deliver,
    });
    disposition.recordQueued();
    const batch = {
      kind: "queued-followup" as const,
      runId: "failed-followup",
      originatingChannel: "webchat",
      payloads: [{ text: "reply" }],
    };
    await expect(disposition.deliver(batch)).rejects.toThrow("broadcast failed");
    await disposition.deliver({ ...batch, runId: "retry" });
    expect(info).toHaveBeenCalledWith(
      "webchat late reply disposition",
      expect.objectContaining({ reason: "delivery-failed" }),
    );
    expect(info).toHaveBeenCalledWith(
      "webchat late reply disposition",
      expect.objectContaining({ reason: "already-settled" }),
    );
    expect(deliver).toHaveBeenCalledOnce();
  });
});
