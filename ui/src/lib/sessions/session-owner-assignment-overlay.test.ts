import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionOwnerAssignmentOverlay } from "./session-owner-assignment-overlay.ts";

function result(ownerId: string, assignedAt: number): SessionsListResult {
  return {
    ts: assignedAt,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:owned",
        kind: "direct",
        updatedAt: assignedAt,
        owner: {
          actor: { type: "human", id: ownerId },
          assignedBy: { type: "human", id: ownerId },
          assignedAt,
        },
      },
    ],
  };
}

describe("session owner assignment overlay", () => {
  it("cancels queued assignments when the connection state is cleared", async () => {
    const overlay = createSessionOwnerAssignmentOverlay();
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let runs = 0;
    const first = overlay.enqueue("agent:main:owned", async () => {
      runs += 1;
      await firstGate;
      return "first";
    });
    const second = overlay.enqueue("agent:main:owned", async () => {
      runs += 1;
      return "second";
    });
    await vi.waitFor(() => expect(runs).toBe(1));

    overlay.clear();
    releaseFirst();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBeNull();
    expect(runs).toBe(1);
  });

  it("keeps the confirmed owner until older same-scope requests settle", () => {
    const overlay = createSessionOwnerAssignmentOverlay();
    const confirmed = result("profile-ada", 20).sessions[0]!.owner!;
    const claim = overlay.confirm("agent:main:owned", confirmed, new Map([["primary", 1]]));

    overlay.observeCanonical(result("profile-ada", 20), 2, "primary");

    expect(overlay.decorate(result("profile-bob", 10))?.sessions[0]?.owner).toEqual(confirmed);

    overlay.settleConfirmed(claim);
    expect(overlay.decorate(result("profile-bob", 10))?.sessions[0]?.owner?.actor.id).toBe(
      "profile-bob",
    );
  });
});
