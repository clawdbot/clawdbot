import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { AgentSessionSteering } from "./agent-session-steering.js";

function userMessage(text: string, sourceSessionKey: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    provenance: {
      kind: "inter_session",
      sourceSessionKey,
      sourceTool: "sessions_send",
    },
  } as AgentMessage;
}

describe("AgentSessionSteering", () => {
  it("preserves reservation FIFO when preparation completes out of order", async () => {
    const steering = new AgentSessionSteering(vi.fn());
    const enqueued: AgentMessage[] = [];
    const first = steering.reserve("first");
    const second = steering.reserve("second");
    const firstMessage = userMessage("first", "agent:first:main");
    const secondMessage = userMessage("second", "agent:second:main");

    expect(
      second.admit("second", secondMessage, () => {
        enqueued.push(secondMessage);
        return { cancel: () => true };
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(enqueued).toEqual([]);

    expect(
      first.admit("first", firstMessage, () => {
        enqueued.push(firstMessage);
        return { cancel: () => true };
      }),
    ).toBe(true);
    await Promise.all([first.receipt.accepted, second.receipt.accepted]);

    expect(enqueued).toEqual([firstMessage, secondMessage]);
    expect(enqueued.map((message) => (message as { provenance?: unknown }).provenance)).toEqual([
      expect.objectContaining({ sourceSessionKey: "agent:first:main" }),
      expect.objectContaining({ sourceSessionKey: "agent:second:main" }),
    ]);
  });

  it("cancels an exact pre-drain reservation without admitting its late message", async () => {
    const steering = new AgentSessionSteering(vi.fn());
    const enqueued: AgentMessage[] = [];
    const first = steering.reserve("same text");
    const second = steering.reserve("same text");
    const secondMessage = userMessage("same text", "agent:second:main");

    second.admit("same text", secondMessage, () => {
      enqueued.push(secondMessage);
      return { cancel: () => true };
    });
    expect(first.receipt.cancel()).toBe(true);
    await expect(first.receipt.accepted).rejects.toThrow("cancelled");
    await second.receipt.accepted;

    const lateFirstMessage = userMessage("same text", "agent:first:main");
    expect(
      first.admit("same text", lateFirstMessage, () => {
        enqueued.push(lateFirstMessage);
        return { cancel: () => true };
      }),
    ).toBe(false);
    expect(enqueued).toEqual([secondMessage]);
  });

  it("commits only the exact message after its persistence owner succeeds", async () => {
    const steering = new AgentSessionSteering(vi.fn());
    const reservation = steering.reserve("persist me");
    const message = userMessage("persist me", "agent:sender:main");
    reservation.admit("persist me", message, () => ({ cancel: () => false }));
    await reservation.receipt.accepted;

    expect(steering.start(message)).toBe(true);
    let committed = false;
    void reservation.receipt.committed.then(() => {
      committed = true;
    });
    await Promise.resolve();
    expect(committed).toBe(false);

    steering.resolve(message);
    await reservation.receipt.committed;
    expect(committed).toBe(true);
  });

  it("rejects commitment when the exact message persistence fails", async () => {
    const steering = new AgentSessionSteering(vi.fn());
    const reservation = steering.reserve("persist me");
    const message = userMessage("persist me", "agent:sender:main");
    reservation.admit("persist me", message, () => ({ cancel: () => false }));
    await reservation.receipt.accepted;
    const error = new Error("transcript write failed");

    steering.reject(message, error);

    await expect(reservation.receipt.committed).rejects.toBe(error);
    expect(reservation.receipt.cancel()).toBe(false);
  });

  it("reports a failed queue cancellation as already owned", async () => {
    const steering = new AgentSessionSteering(vi.fn());
    const reservation = steering.reserve("already drained");
    const message = userMessage("already drained", "agent:sender:main");
    reservation.admit("already drained", message, () => ({ cancel: () => false }));
    await reservation.receipt.accepted;

    expect(reservation.receipt.cancel()).toBe(false);
    expect(steering.pendingCount).toBe(0);
    steering.resolve(message);
    await expect(reservation.receipt.committed).resolves.toBeUndefined();
  });
});
