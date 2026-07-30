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

  it("spares a victim that gains a viewer during the replacement spawn", async () => {
    const victimPty = makeFakePty();
    const replacementPty = makeFakePty();
    let releaseSpawn: (() => void) | undefined;
    let spawnCount = 0;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => {
        spawnCount += 1;
        if (spawnCount === 1) {
          return victimPty;
        }
        await new Promise<void>((resolve) => {
          releaseSpawn = resolve;
        });
        return replacementPty;
      },
      maxSessions: 1,
    });
    const victim = await manager.open(baseOpenRequest({ owner: agentOwner }));
    if (!victim.ok) {
      throw new Error("expected open");
    }

    const opening = manager.open(baseOpenRequest({ owner: agentOwner }));
    await vi.waitFor(() => expect(releaseSpawn).toBeDefined());
    // The claimed victim becomes viewer-attached while the replacement spawns.
    expect(manager.attach("viewer-1", victim.sessionId)?.sessionId).toBe(victim.sessionId);
    releaseSpawn?.();

    const outcome = await opening;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("limit");
    }
    // The now-viewered session survives; the orphaned replacement is killed.
    expect(victimPty.killed).toBe(false);
    expect(replacementPty.killed).toBe(true);
    expect(manager.size).toBe(1);
    expect(manager.writeAgent("agent:main:main", victim.sessionId, "still-alive\r")).toBe(true);
  });

  it("evicts the freshly idlest session when the claimed victim becomes active mid-spawn", async () => {
    vi.useFakeTimers();
    try {
      const ptys: FakeTerminalPty[] = [];
      let releaseSpawn: (() => void) | undefined;
      let gateNextSpawn = false;
      const manager = new TerminalSessionManager({
        emit: vi.fn(),
        spawn: async () => {
          const pty = makeFakePty();
          ptys.push(pty);
          if (gateNextSpawn) {
            await new Promise<void>((resolve) => {
              releaseSpawn = resolve;
            });
          }
          return pty;
        },
        maxSessions: 2,
      });
      const oldest = await manager.open(baseOpenRequest({ owner: agentOwner }));
      await vi.advanceTimersByTimeAsync(5_000);
      const newer = await manager.open(baseOpenRequest({ owner: agentOwner }));
      if (!oldest.ok || !newer.ok) {
        throw new Error("expected agent opens");
      }

      gateNextSpawn = true;
      const opening = manager.open(baseOpenRequest({ owner: agentOwner }));
      await vi.waitFor(() => expect(releaseSpawn).toBeDefined());
      // The claimed (oldest) session becomes active during the spawn, making
      // the newer session the genuinely idlest candidate.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(manager.writeAgent("agent:main:main", oldest.sessionId, "busy\r")).toBe(true);
      releaseSpawn?.();

      const outcome = await opening;
      expect(outcome.ok).toBe(true);
      expect(manager.size).toBe(2);
      expect(expectDefined(ptys[0], "oldest pty invariant").killed).toBe(false);
      expect(expectDefined(ptys[1], "newer pty invariant").killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the cap when concurrent opens complete out of order", async () => {
    const gates: Array<(pty: FakeTerminalPty) => void> = [];
    const spawned: FakeTerminalPty[] = [];
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => {
        const pty = await new Promise<FakeTerminalPty>((resolve) => {
          gates.push(resolve);
        });
        spawned.push(pty);
        return pty;
      },
      maxSessions: 2,
    });
    const seeded = manager.open(baseOpenRequest({ owner: agentOwner }));
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]?.(makeFakePty());
    const seededOutcome = await seeded;
    expect(seededOutcome.ok).toBe(true);

    // A reserves the free slot; B sees the reservation and claims the seeded
    // session for eviction. B's spawn completes first.
    const openA = manager.open(baseOpenRequest({ owner: agentOwner }));
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    const openB = manager.open(baseOpenRequest({ owner: agentOwner }));
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    gates[2]?.(makeFakePty());
    const outcomeB = await openB;
    gates[1]?.(makeFakePty());
    const outcomeA = await openA;

    expect(outcomeA.ok).toBe(true);
    expect(outcomeB.ok).toBe(true);
    // The hard cap survives the out-of-order completion.
    expect(manager.size).toBeLessThanOrEqual(2);
  });

  it("releases the eviction claim when a cancelled open's spawn never settles", async () => {
    let hangNextSpawn = false;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => {
        if (hangNextSpawn) {
          hangNextSpawn = false;
          return await new Promise<never>(() => {});
        }
        return makeFakePty();
      },
      maxSessions: 1,
    });
    const victim = await manager.open(baseOpenRequest({ owner: agentOwner }));
    if (!victim.ok) {
      throw new Error("expected open");
    }

    hangNextSpawn = true;
    const controller = new AbortController();
    const hung = manager.open(baseOpenRequest({ owner: agentOwner, signal: controller.signal }));
    await vi.waitFor(() => expect(hangNextSpawn).toBe(false));
    controller.abort(new Error("cancelled"));

    // The cancelled open's claim is gone, so a later open can evict the victim.
    const next = await manager.open(baseOpenRequest({ owner: agentOwner }));
    expect(next.ok).toBe(true);
    expect(manager.size).toBe(1);
    // The hung open stays pending forever by design; do not await it.
    void hung;
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
