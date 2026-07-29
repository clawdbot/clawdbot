// Tests session update lifecycle ordering and active-session state transitions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
}));

let incrementCompactionCount: typeof import("./session-updates.js").incrementCompactionCount;
const tempDirs: string[] = [];

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-updates-"));
  tempDirs.push(root);
  const storePath = path.join(root, "sessions.json");
  const sessionKey = "agent:main:forum:direct:compaction";
  const transcriptPath = path.join(root, "s1.jsonl");
  await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf-8");
  const entry = {
    sessionId: "s1",
    sessionFile: transcriptPath,
    updatedAt: Date.now(),
    compactionCount: 0,
  } as SessionEntry;
  const sessionStore: Record<string, SessionEntry> = {
    [sessionKey]: entry,
  };
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  return { storePath, sessionKey, sessionStore, entry, transcriptPath };
}

function firstSessionEndCall() {
  return hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
}

function firstSessionStartCall() {
  return hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
}

describe("session-updates lifecycle hooks", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    vi.resetModules();
    vi.doMock("../../plugins/hook-runner-global.js", () => ({
      getGlobalHookRunner: () =>
        ({
          hasHooks: hookRunnerMocks.hasHooks,
          runSessionEnd: hookRunnerMocks.runSessionEnd,
          runSessionStart: hookRunnerMocks.runSessionStart,
        }) as unknown as HookRunner,
    }));
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_end" || hookName === "session_start",
    );
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
    ({ incrementCompactionCount } = await import("./session-updates.js"));
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("emits compaction lifecycle hooks when newSessionId replaces the session", async () => {
    const { storePath, sessionKey, sessionStore, entry, transcriptPath } = await createFixture();
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await incrementCompactionCount({
      cfg,
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      newSessionId: "s2",
    });

    expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);

    const [endEvent, endContext] = firstSessionEndCall();
    const [startEvent, startContext] = firstSessionStartCall();

    expect(endEvent?.sessionId).toBe("s1");
    expect(endEvent?.sessionKey).toBe(sessionKey);
    expect(endEvent?.reason).toBe("compaction");
    expect(endEvent?.transcriptArchived).toBe(false);
    expect(endEvent?.sessionFile).toBe(await fs.realpath(transcriptPath));
    expect(endContext?.sessionId).toBe("s1");
    expect(endContext?.sessionKey).toBe(sessionKey);
    expect(endContext?.agentId).toBe("main");
    expect(endEvent?.nextSessionId).toBe(startEvent?.sessionId);
    expect(startEvent?.sessionId).toBe("s2");
    expect(startEvent?.sessionKey).toBe(sessionKey);
    expect(startEvent?.resumedFrom).toBe("s1");
    expect(startContext?.sessionId).toBe("s2");
    expect(startContext?.sessionKey).toBe(sessionKey);
    expect(startContext?.agentId).toBe("main");
  });

  it("keeps compaction lifecycle hooks root-admitted until both settle", async () => {
    const { storePath, sessionKey, sessionStore, entry } = await createFixture();
    const releases: Array<() => void> = [];
    const heldHook = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    hookRunnerMocks.runSessionEnd.mockImplementationOnce(heldHook);
    hookRunnerMocks.runSessionStart.mockImplementationOnce(heldHook);

    await incrementCompactionCount({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      newSessionId: "s2",
    });

    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(2));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases) {
      release();
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("hands compaction lifecycle hooks off after restart drain closes admission", async () => {
    const { storePath, sessionKey, sessionStore, entry } = await createFixture();
    const releases: Array<() => void> = [];
    const heldHook = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    hookRunnerMocks.runSessionEnd.mockImplementationOnce(heldHook);
    hookRunnerMocks.runSessionStart.mockImplementationOnce(heldHook);
    const admission = tryBeginGatewayRootWorkAdmission();
    expect(admission).not.toBeNull();

    await admission?.run(async () => {
      markGatewayRestartDraining();
      await incrementCompactionCount({
        cfg: { session: { store: storePath } } as OpenClawConfig,
        sessionEntry: entry,
        sessionStore,
        sessionKey,
        storePath,
        newSessionId: "s2",
      });
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      expect(getActiveGatewayRootWorkCount()).toBe(3);
    });

    admission?.release();
    expect(getActiveGatewayRootWorkCount()).toBe(2);
    for (const release of releases) {
      release();
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
  });

  it("recreates a complete persisted row when compaction updates a missing store row", async () => {
    const { storePath, sessionKey, sessionStore, entry } = await createFixture();
    await applySessionEntryLifecycleMutation({
      storePath,
      removals: [{ sessionKey }],
      skipMaintenance: true,
    });

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      newSessionId: "s2",
      tokensAfter: 123,
      now: 456,
    });

    const persisted = loadSessionEntry({ storePath, sessionKey });
    expect(sessionStore[sessionKey]?.sessionId).toBe("s2");
    expect(sessionStore[sessionKey]).not.toHaveProperty("sessionFile");
    expect(sessionStore[sessionKey]?.usageFamilyKey).toBe(sessionKey);
    expect(sessionStore[sessionKey]?.usageFamilySessionIds).toEqual(["s1", "s2"]);
    expect(sessionStore[sessionKey]?.compactionCount).toBe(1);
    expect(sessionStore[sessionKey]?.totalTokens).toBe(123);
    expect(sessionStore[sessionKey]?.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt);
    expect(persisted?.sessionId).toBe("s2");
    expect(persisted).not.toHaveProperty("sessionFile");
    expect(persisted?.usageFamilyKey).toBe(sessionKey);
    expect(persisted?.usageFamilySessionIds).toEqual(["s1", "s2"]);
    expect(persisted?.compactionCount).toBe(1);
    expect(persisted?.totalTokens).toBe(123);
    expect(persisted?.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt);
  });
});
