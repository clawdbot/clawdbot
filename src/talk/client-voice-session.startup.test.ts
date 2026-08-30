import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session.js";

describe("client voice session startup", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-startup-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not create a chat when browser startup closes while its write is queued", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = patchSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:voice-write-blocker" },
      async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
      { fallbackEntry: { sessionId: "voice-write-blocker", updatedAt: 1 } },
    );
    await entered.promise;
    const target = { agentId: "main", sessionKey: "agent:main:voice-write-cancelled" };
    const controller = new AbortController();
    const creating = ensureClientVoiceAgentSessionEntry({
      ...target,
      assertCommitAllowed: () => controller.signal.throwIfAborted(),
    });
    controller.abort(new Error("browser disconnected"));
    const rejected = expect(creating).rejects.toThrow("browser disconnected");
    release.resolve();
    await blocker;
    await rejected;
    expect(loadSessionEntry(target)).toBeUndefined();
  });
});
