// Tests that force-clearing an embedded run persists terminal session state.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { abortAndDrainEmbeddedAgentRun, setActiveEmbeddedRun } from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    abort?: () => void;
    isStreaming?: boolean;
  } = {},
): RunHandle {
  return {
    queueMessage: async () => {},
    isStreaming: () => overrides.isStreaming ?? true,
    isCompacting: () => false,
    abort: overrides.abort ?? (() => {}),
  };
}

describe("force-clear terminal state persistence", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-forceclear-");
    storePath = path.join(tempDir, "sessions.json");
    setRuntimeConfigSnapshot({ session: { store: storePath } } as unknown as OpenClawConfig);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
  });

  it("persists killed status after a force-cleared run", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "session-1";
    const startedAt = Date.now() - 60_000;

    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: startedAt,
        startedAt,
        status: "running",
      },
    );

    setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.status).toBe("killed");
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.endedAt).toBeGreaterThanOrEqual(startedAt);
    expect(entry?.runtimeMs).toBeGreaterThan(0);
  });

  it("does not fail when the session entry is absent", async () => {
    const sessionKey = "agent:main:missing";
    const sessionId = "session-missing";

    setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);
  });

  it("does not persist state when sessionKey is omitted", async () => {
    const sessionId = "session-no-key";
    const sessionKey = "agent:main:no-key";

    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    setActiveEmbeddedRun(sessionId, createRunHandle());

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.status).toBe("running");
  });

  it("does not overwrite a newer session entry under the same key", async () => {
    const sessionKey = "agent:main:shared-key";
    const oldSessionId = "session-old";
    const newSessionId = "session-new";

    // Seed the store with the original session entry.
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: oldSessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    setActiveEmbeddedRun(oldSessionId, createRunHandle(), sessionKey);

    // Simulate the session key advancing to a replacement session before the
    // stale force-clear persistence fires.
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: newSessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId: oldSessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.sessionId).toBe(newSessionId);
    expect(entry?.status).toBe("running");
  });
});
