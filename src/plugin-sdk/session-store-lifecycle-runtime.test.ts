import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { resetPluginRuntimeSessionEntryLifecycle } from "./session-store-lifecycle-runtime.js";
import { getSessionEntry, upsertSessionEntry, type SessionEntry } from "./session-store-runtime.js";

describe("session-store lifecycle runtime", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-session-lifecycle-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedSessionEntry(sessionKey: string, entry: SessionEntry): Promise<void> {
    await upsertSessionEntry({ agentId: "main", sessionKey, storePath, entry });
  }

  it("resets a session through the lifecycle owner without retaining the old transcript", async () => {
    const sessionKey = "agent:main:main";
    const oldTranscriptPath = path.join(tempDir, "old-session.jsonl");
    fs.writeFileSync(oldTranscriptPath, '{"type":"session","id":"old-session"}\n', "utf-8");
    await seedSessionEntry(sessionKey, {
      label: "Dale",
      sessionFile: oldTranscriptPath,
      sessionId: "old-session",
      updatedAt: 10,
    });

    const result = await resetPluginRuntimeSessionEntryLifecycle({
      expectedSessionId: "old-session",
      expectedUpdatedAt: 10,
      sessionKey,
      storePath,
      update: (entry) => ({ label: entry.label, updatedAt: 0 }),
    });

    expect(result).toMatchObject({ label: "Dale", updatedAt: 0 });
    expect(result?.sessionId).not.toBe("old-session");
    expect(result?.sessionFile).toContain(`${result?.sessionId}.jsonl`);
    const persisted = getSessionEntry({ sessionKey, storePath });
    expect(persisted).toMatchObject({
      sessionId: result?.sessionId,
    });
    expect(persisted?.sessionFile).not.toBe(oldTranscriptPath);
    expect(result?.sessionFile).not.toBe(oldTranscriptPath);
  });

  it("interrupts active work before lifecycle reset rotation", async () => {
    const sessionKey = "agent:main:main";
    const oldTranscriptPath = path.join(tempDir, "active-old-session.jsonl");
    fs.writeFileSync(oldTranscriptPath, '{"type":"session","id":"active-old-session"}\n', "utf-8");
    await seedSessionEntry(sessionKey, {
      sessionFile: oldTranscriptPath,
      sessionId: "active-old-session",
      updatedAt: 10,
    });

    let interrupted = false;
    let releaseAdmission = () => {};
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, "active-old-session"],
      assertAllowed: () => {},
      onInterrupt: () => {
        interrupted = true;
        releaseAdmission();
      },
    });
    releaseAdmission = admission.release;

    try {
      const result = await resetPluginRuntimeSessionEntryLifecycle({
        expectedSessionId: "active-old-session",
        expectedUpdatedAt: 10,
        sessionKey,
        storePath,
        update: () => ({ updatedAt: 0 }),
      });
      expect(interrupted).toBe(true);
      expect(result).toMatchObject({ updatedAt: 0 });
      expect(result?.sessionId).not.toBe("active-old-session");
    } finally {
      admission.release();
    }
  });

  it("keeps a durable pending boundary when active work cannot drain", async () => {
    const sessionKey = "agent:main:main";
    await seedSessionEntry(sessionKey, {
      sessionId: "blocked-old-session",
      updatedAt: 10,
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, "blocked-old-session"],
      assertAllowed: () => {},
      onInterrupt: () => {},
    });
    vi.useFakeTimers();
    try {
      const reset = resetPluginRuntimeSessionEntryLifecycle({
        expectedSessionId: "blocked-old-session",
        expectedUpdatedAt: 10,
        sessionKey,
        storePath,
        update: () => ({ updatedAt: 0 }),
      });
      const outcome = reset.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
      expect((await outcome).error).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("timed out draining work"),
        }),
      );

      const pending = getSessionEntry({ sessionKey, storePath });
      expect(pending).toMatchObject({
        initializationPending: true,
        sessionId: "blocked-old-session",
      });
      expect(pending?.lifecycleRevision).toMatch(/^reset:/);
      expect(resolveSessionWorkStartError(sessionKey, pending)).toContain("still initializing");
    } finally {
      admission.release();
      vi.useRealTimers();
    }

    const retried = await resetPluginRuntimeSessionEntryLifecycle({
      expectedSessionId: "blocked-old-session",
      expectedUpdatedAt: 10,
      sessionKey,
      storePath,
      update: () => ({ updatedAt: 0 }),
    });
    expect(retried?.sessionId).not.toBe("blocked-old-session");
    expect(retried?.initializationPending).toBeUndefined();
  });

  it("rejects locked harness lifecycle reset without a physical owner release hook", async () => {
    const sessionKey = "agent:main:harness:codex:thread";
    await seedSessionEntry(sessionKey, lockedEntry());

    await expect(
      resetPluginRuntimeSessionEntryLifecycle({
        expectedSessionId: "locked-old-session",
        expectedUpdatedAt: 10,
        sessionKey,
        storePath,
        update: () => ({ updatedAt: 0 }),
      }),
    ).rejects.toThrow("requires physical owner release");
    const pending = getSessionEntry({ sessionKey, storePath });
    expect(pending).toMatchObject({
      initializationPending: true,
      sessionId: "locked-old-session",
    });
    expect(pending?.lifecycleRevision).toMatch(/^reset:/);
    expect(resolveSessionWorkStartError(sessionKey, pending)).toContain("still initializing");
  });

  it("keeps a durable boundary after owner failure and clears it on retry", async () => {
    const sessionKey = "agent:main:harness:codex:thread";
    await seedSessionEntry(sessionKey, lockedEntry());

    await expect(
      resetPluginRuntimeSessionEntryLifecycle({
        expectedSessionId: "locked-old-session",
        expectedUpdatedAt: 10,
        releasePhysicalOwner: () => {
          throw new Error("native reset failed");
        },
        sessionKey,
        storePath,
        update: () => ({ updatedAt: 0 }),
      }),
    ).rejects.toThrow("native reset failed");
    const pending = getSessionEntry({ sessionKey, storePath });
    expect(pending).toMatchObject({
      initializationPending: true,
      sessionId: "locked-old-session",
    });
    expect(pending?.lifecycleRevision).toMatch(/^reset:/);
    expect(resolveSessionWorkStartError(sessionKey, pending)).toContain("still initializing");

    const retried = await resetPluginRuntimeSessionEntryLifecycle({
      expectedSessionId: "locked-old-session",
      expectedUpdatedAt: 10,
      releasePhysicalOwner: () => {},
      sessionKey,
      storePath,
      update: () => ({ updatedAt: 0 }),
    });
    expect(retried?.sessionId).not.toBe("locked-old-session");
    expect(retried?.initializationPending).toBeUndefined();
    expect(retried?.lifecycleRevision).toBeUndefined();
  });

  it("releases locked physical ownership before publishing the replacement session", async () => {
    const sessionKey = "agent:main:harness:codex:thread";
    const releaseCalls: Array<{ sessionId: string; lifecycleRevision?: string }> = [];
    await seedSessionEntry(sessionKey, lockedEntry());

    const result = await resetPluginRuntimeSessionEntryLifecycle({
      expectedSessionId: "locked-old-session",
      expectedUpdatedAt: 10,
      releasePhysicalOwner: (context) => {
        releaseCalls.push({
          lifecycleRevision: context.entry.lifecycleRevision,
          sessionId: context.sessionId,
        });
      },
      sessionKey,
      storePath,
      update: () => ({ label: "rotated", updatedAt: 0 }),
    });

    expect(releaseCalls).toEqual([
      { lifecycleRevision: "original-revision", sessionId: "locked-old-session" },
    ]);
    expect(result).toMatchObject({ label: "rotated", updatedAt: 0 });
    expect(result?.sessionId).not.toBe("locked-old-session");
    expect(result?.lifecycleRevision).toBeUndefined();
  });

  it("finalizes a fresh ownerless row when the reserved row changes after physical owner release", async () => {
    const sessionKey = "agent:main:harness:codex:thread";
    await seedSessionEntry(sessionKey, lockedEntry());

    await expect(
      resetPluginRuntimeSessionEntryLifecycle({
        expectedSessionId: "locked-old-session",
        expectedUpdatedAt: 10,
        releasePhysicalOwner: async () => {
          const entry = getSessionEntry({ sessionKey, storePath });
          if (!entry) {
            throw new Error("expected reserved session entry");
          }
          await replaceSessionEntry({ sessionKey, storePath }, { ...entry, updatedAt: 11 });
        },
        sessionKey,
        storePath,
        update: () => ({ updatedAt: 0 }),
      }),
    ).rejects.toThrow("skipped after physical owner release");
    const replacement = getSessionEntry({ sessionKey, storePath });
    expect(replacement?.sessionId).toBeTruthy();
    expect(replacement?.sessionId).not.toBe("locked-old-session");
    expect(replacement?.agentHarnessId).toBeUndefined();
    expect(replacement?.modelSelectionLocked).toBeUndefined();
    expect(replacement?.lifecycleRevision).toBeUndefined();
  });

  it("publishes a fresh unlocked row when finalization skips after physical owner release", async () => {
    const sessionKey = "agent:main:harness:codex:thread";
    await seedSessionEntry(sessionKey, lockedEntry());

    await expect(
      resetPluginRuntimeSessionEntryLifecycle({
        expectedSessionId: "locked-old-session",
        expectedUpdatedAt: 10,
        releasePhysicalOwner: () => {},
        sessionKey,
        storePath,
        update: () => null,
      }),
    ).rejects.toThrow("skipped after physical owner release");

    const replacement = getSessionEntry({ sessionKey, storePath });
    expect(replacement?.sessionId).toBeTruthy();
    expect(replacement?.sessionId).not.toBe("locked-old-session");
    expect(replacement?.agentHarnessId).toBeUndefined();
    expect(replacement?.modelSelectionLocked).toBeUndefined();
    expect(replacement?.lifecycleRevision).toBeUndefined();
  });
});

function lockedEntry(): SessionEntry {
  return {
    agentHarnessId: "codex",
    lifecycleRevision: "original-revision",
    modelSelectionLocked: true,
    sessionId: "locked-old-session",
    updatedAt: 10,
  };
}
