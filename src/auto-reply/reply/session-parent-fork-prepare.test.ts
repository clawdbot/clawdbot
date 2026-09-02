import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";

const forkMocks = vi.hoisted(() => ({
  forkSessionFromParent: vi.fn(),
  resolveParentForkDecision: vi.fn(),
}));

vi.mock("./session-fork.js", () => forkMocks);

import {
  canReplaceRestartTombstoneFromParent,
  prepareReplySessionParentFork,
} from "./session-parent-fork-prepare.js";

describe("prepareReplySessionParentFork", () => {
  beforeEach(() => {
    forkMocks.forkSessionFromParent.mockReset().mockResolvedValue({
      sessionId: "forked-session",
      sessionFile: "/tmp/forked-session.jsonl",
    });
    forkMocks.resolveParentForkDecision.mockReset().mockResolvedValue({
      status: "fork",
      maxTokens: 100_000,
      parentTokens: 10_000,
    });
  });

  it("requires human mutation authority for tombstone parent replacement", () => {
    const entry: InternalSessionEntry = {
      sessionId: "tombstoned-session",
      updatedAt: 1,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    };
    const allowed = {
      actorType: "human" as const,
      entry,
      hasParentForkSource: true,
      inboundAccessAuthorized: true,
      inboundEventKind: "user_request",
      sessionKey: "agent:main:child",
    };

    expect(canReplaceRestartTombstoneFromParent(allowed)).toBe(true);
    expect(
      canReplaceRestartTombstoneFromParent({
        ...allowed,
        entry: { ...entry, modelSelectionLocked: true },
      }),
    ).toBe(false);
    expect(
      canReplaceRestartTombstoneFromParent({ ...allowed, inboundAccessAuthorized: false }),
    ).toBe(false);
    expect(
      canReplaceRestartTombstoneFromParent({ ...allowed, inboundEventKind: "room_event" }),
    ).toBe(false);
    expect(canReplaceRestartTombstoneFromParent({ ...allowed, actorType: "system" })).toBe(false);
    expect(canReplaceRestartTombstoneFromParent({ ...allowed, hasPluginOwnedBinding: true })).toBe(
      false,
    );
    expect(
      canReplaceRestartTombstoneFromParent({
        ...allowed,
        nativeCommandTarget: "agent:main:other",
      }),
    ).toBe(false);
  });

  it("clears run identities when the parent fork replaces the transcript generation", async () => {
    const parentEntry: SessionEntry = {
      sessionId: "parent-session",
      updatedAt: 1,
    };
    const sessionEntry: InternalSessionEntry = {
      sessionId: "provisional-session",
      updatedAt: 2,
      lifecycleRunId: "active-provisional-run",
      lastRunId: "settled-provisional-run",
    };

    const result = (await prepareReplySessionParentFork({
      agentId: "main",
      alreadyForked: false,
      parentSessionKey: "agent:main:parent",
      readEntry: () => parentEntry,
      sessionEntry,
      sessionKey: "agent:main:child",
      storePath: "/tmp/sessions.json",
      warn: vi.fn(),
    })) as InternalSessionEntry;

    expect(result.sessionId).toBe("forked-session");
    expect(result.lifecycleRunId).toBeUndefined();
    expect(result.lastRunId).toBeUndefined();
  });

  it("rejects required replacement when the parent disappears before commit", async () => {
    await expect(
      prepareReplySessionParentFork({
        agentId: "main",
        alreadyForked: false,
        parentSessionKey: "agent:main:parent",
        readEntry: () => undefined,
        requireParentForkReplacement: true,
        sessionEntry: { sessionId: "provisional-session", updatedAt: 2 },
        sessionKey: "agent:main:child",
        storePath: "/tmp/sessions.json",
        warn: vi.fn(),
      }),
    ).rejects.toThrow(/ended during restart recovery/i);
    expect(forkMocks.resolveParentForkDecision).not.toHaveBeenCalled();
    expect(forkMocks.forkSessionFromParent).not.toHaveBeenCalled();
  });
});
