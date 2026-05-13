import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { HookRunner } from "../../plugins/hooks.js";

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
  await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
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
});
