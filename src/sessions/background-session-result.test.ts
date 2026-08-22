import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { commitBackgroundResultToSession } from "./background-session-result.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
} from "./session-lifecycle-admission.js";
import { onSessionTranscriptUpdate } from "./transcript-events.js";

describe("commitBackgroundResultToSession", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  async function createTarget() {
    const dir = tempDirs.make("openclaw-background-result-");
    const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:webchat:direct:owner";
    const sessionId = "source-session";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, lifecycleRevision: "source-revision", updatedAt: 1 },
    );
    return {
      config: { session: { store: storePath } },
      sessionId,
      sessionKey,
      storePath,
    };
  }

  it("waits for active source work, commits provenance, and deduplicates retry", async () => {
    const target = await createTarget();
    const admission = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [target.sessionKey, target.sessionId],
      assertAllowed: () => {},
    });
    let commitSettled = false;
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    const commit = commitBackgroundResultToSession({
      agentId: "main",
      sessionKey: target.sessionKey,
      text: "Automation finished while the chat was active.",
      idempotencyKey: "cron-current-completion:cron:job-1:1000",
      provenance: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
      config: target.config,
    });
    void commit.then(() => {
      commitSettled = true;
    });

    await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBe(1));
    expect(commitSettled).toBe(false);
    let laterAdmissionSettled = false;
    const laterAdmission = beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [target.sessionKey, target.sessionId],
      assertAllowed: () => {},
    });
    void laterAdmission.then(() => {
      laterAdmissionSettled = true;
    });
    await Promise.resolve();
    expect(laterAdmissionSettled).toBe(false);
    admission.release();

    const first = await commit;
    expect(first).toMatchObject({ ok: true });
    (await laterAdmission).release();
    const retry = await commitBackgroundResultToSession({
      agentId: "main",
      sessionKey: target.sessionKey,
      text: "Automation finished while the chat was active.",
      idempotencyKey: "cron-current-completion:cron:job-1:1000",
      provenance: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
      config: target.config,
    });
    expect(retry).toEqual(first);

    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          api: "openclaw-transcript",
          idempotencyKey: "cron-current-completion:cron:job-1:1000",
          model: "automation-result",
          openclawAutomation: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
          provider: "openclaw",
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Automation finished while the chat was active." }],
          usage: expect.objectContaining({ input: 0, output: 0, totalTokens: 0 }),
        }),
      }),
    ]);
    expect(updates).toHaveLength(1);
    unsubscribe();
  });

  it("refuses an archived target conversation", async () => {
    const target = await createTarget();
    await replaceSessionEntry(
      { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
      {
        sessionId: target.sessionId,
        lifecycleRevision: "source-revision",
        updatedAt: 2,
        archivedAt: 2,
      },
    );

    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        text: "Do not append this.",
        idempotencyKey: "cron-current-completion:cron:job-2:2000",
        provenance: { kind: "cron", jobId: "job-2", runId: "cron:job-2:2000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("archived") });
  });
});
