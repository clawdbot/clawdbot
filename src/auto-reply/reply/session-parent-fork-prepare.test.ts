import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";

const forkMocks = vi.hoisted(() => ({
  forkSessionFromParent: vi.fn(),
  resolveParentForkDecision: vi.fn(),
}));

vi.mock("./session-fork.js", () => forkMocks);

import { prepareReplySessionParentFork } from "./session-parent-fork-prepare.js";

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
});
