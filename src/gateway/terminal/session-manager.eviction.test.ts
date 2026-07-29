// Idle-eviction under pool pressure: one busy agent must not brick terminal
// opens gateway-wide until restart.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./session-manager.js";
import {
  baseOpenRequest,
  type FakeTerminalPty,
  makeFakePty,
} from "./session-manager.test-helpers.js";

const agentOwner = { kind: "agent", agentSessionKey: "agent:main:main" } as const;

function trackingManager(maxSessions: number) {
  const ptys: FakeTerminalPty[] = [];
  const manager = new TerminalSessionManager({
    emit: vi.fn(),
    spawn: async () => {
      const pty = makeFakePty();
      ptys.push(pty);
      return pty;
    },
    maxSessions,
  });
  return { manager, ptys };
}

describe("TerminalSessionManager idle eviction", () => {
  it("evicts the longest-idle viewer-free agent session under pool pressure", async () => {
    vi.useFakeTimers();
    try {
      const { manager, ptys } = trackingManager(2);
      const first = await manager.open(baseOpenRequest({ owner: agentOwner }));
      await vi.advanceTimersByTimeAsync(5_000);
      const second = await manager.open(baseOpenRequest({ owner: agentOwner }));
      if (!first.ok || !second.ok) {
        throw new Error("expected agent opens");
      }
      // Freshen the second session so the first is the idle-eviction candidate.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(manager.writeAgent("agent:main:main", second.sessionId, "keepalive\r")).toBe(true);

      const third = await manager.open(baseOpenRequest({ owner: agentOwner }));
      expect(third.ok).toBe(true);
      expect(manager.size).toBe(2);
      expect(expectDefined(ptys[0], "ptys[0] test invariant").killed).toBe(true);
      expect(expectDefined(ptys[1], "ptys[1] test invariant").killed).toBe(false);
      expect(manager.snapshotAgent("agent:main:main", first.sessionId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never evicts viewer-attached or connection-owned sessions under pressure", async () => {
    const { manager, ptys } = trackingManager(2);
    const connOwned = await manager.open(baseOpenRequest());
    const viewed = await manager.open(baseOpenRequest({ owner: agentOwner }));
    if (!connOwned.ok || !viewed.ok) {
      throw new Error("expected opens");
    }
    expect(manager.attach("viewer-1", viewed.sessionId)?.sessionId).toBe(viewed.sessionId);

    const denied = await manager.open(baseOpenRequest({ owner: agentOwner }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("limit");
    }
    expect(manager.size).toBe(2);
    expect(ptys.some((pty) => pty.killed)).toBe(false);
  });

  it("keeps the claimed victim alive when the replacement spawn fails", async () => {
    const pty = makeFakePty();
    let failNextSpawn = false;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => {
        if (failNextSpawn) {
          throw new Error("pty exhausted");
        }
        return pty;
      },
      maxSessions: 1,
    });
    const victim = await manager.open(baseOpenRequest({ owner: agentOwner }));
    if (!victim.ok) {
      throw new Error("expected open");
    }

    failNextSpawn = true;
    const failed = await manager.open(baseOpenRequest({ owner: agentOwner }));
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("spawn_failed");
    }
    // The victim survives a failed replacement and stays claimable later.
    expect(manager.size).toBe(1);
    expect(pty.killed).toBe(false);
    expect(manager.writeAgent("agent:main:main", victim.sessionId, "still-alive\r")).toBe(true);

    failNextSpawn = false;
    const replacement = await manager.open(baseOpenRequest({ owner: agentOwner }));
    expect(replacement.ok).toBe(true);
    expect(manager.size).toBe(1);
    expect(pty.killed).toBe(true);
  });
});
