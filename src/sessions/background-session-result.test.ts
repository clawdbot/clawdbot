import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { commitBackgroundResultToSession } from "./background-session-result.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
} from "./session-lifecycle-admission.js";
import { onSessionTranscriptUpdate } from "./transcript-events.js";

describe("commitBackgroundResultToSession", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeOpenClawAgentDatabasesForTest();
      cleanup();
    }),
  );

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
      generation: { sessionId, lifecycleRevision: "source-revision" },
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
      expectedGeneration: target.generation,
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
    expect(first).toMatchObject({ ok: true, appended: true });
    (await laterAdmission).release();
    const retry = await commitBackgroundResultToSession({
      agentId: "main",
      sessionKey: target.sessionKey,
      expectedGeneration: target.generation,
      text: "Automation finished while the chat was active.",
      idempotencyKey: "cron-current-completion:cron:job-1:1000",
      provenance: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
      config: target.config,
    });
    expect(retry).toMatchObject({
      ok: true,
      messageId: first.ok ? first.messageId : undefined,
      appended: false,
    });

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

  it("stores model-safe text separately from rich display content", async () => {
    const target = await createTarget();
    const displayContent = [
      { type: "text", text: "Automation finished with an image." },
      {
        type: "image",
        url: "/api/chat/media/outgoing/source-session/attachment/report.png",
      },
    ];
    const committed: Array<{ appended: boolean; displayContent: unknown }> = [];
    const recordCommitted = (result: { appended: boolean; message: unknown }) => {
      committed.push({
        appended: result.appended,
        displayContent: (result.message as Record<string, unknown>)[
          ASSISTANT_DISPLAY_CONTENT_FIELD
        ],
      });
    };
    const commitParams = {
      agentId: "main",
      sessionKey: target.sessionKey,
      expectedGeneration: target.generation,
      text: "Automation finished with an image.",
      displayContent,
      idempotencyKey: "cron-current-completion:cron:job-media:1500",
      provenance: { kind: "cron" as const, jobId: "job-media", runId: "cron:job-media:1500" },
      config: target.config,
      onMessageCommitted: recordCommitted,
    };

    await expect(commitBackgroundResultToSession(commitParams)).resolves.toMatchObject({
      ok: true,
      appended: true,
    });
    await expect(
      commitBackgroundResultToSession({
        ...commitParams,
        displayContent: [
          {
            type: "image",
            url: "/api/chat/media/outgoing/source-session/attachment/retry.png",
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, appended: false });

    expect(committed).toEqual([
      { appended: true, displayContent },
      { appended: false, displayContent },
    ]);
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
          content: [{ type: "text", text: "Automation finished with an image." }],
          [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent,
        }),
      }),
    ]);
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
        expectedGeneration: target.generation,
        text: "Do not append this.",
        idempotencyKey: "cron-current-completion:cron:job-2:2000",
        provenance: { kind: "cron", jobId: "job-2", runId: "cron:job-2:2000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("archived") });
  });

  it.each([
    {
      name: "session-id replacement",
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-revision",
    },
    {
      name: "same-id lifecycle replacement",
      sessionId: "source-session",
      lifecycleRevision: "replacement-revision",
    },
  ])("refuses a result captured before $name", async (replacement) => {
    const target = await createTarget();
    await replaceSessionEntry(
      { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
      {
        sessionId: replacement.sessionId,
        lifecycleRevision: replacement.lifecycleRevision,
        updatedAt: 2,
      },
    );

    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: target.generation,
        text: "Do not append this stale cron result.",
        displayContent: [
          { type: "text", text: "Do not append this stale cron result." },
          {
            type: "image",
            url: "/api/chat/media/outgoing/source-session/attachment/stale.png",
          },
        ],
        idempotencyKey: "cron-current-completion:cron:job-stale:3000",
        provenance: { kind: "cron", jobId: "job-stale", runId: "cron:job-stale:3000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("session rebound") });

    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: replacement.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      }),
    ).resolves.toEqual([]);
  });

  it("treats a missing lifecycle revision as exact generation state", async () => {
    const target = await createTarget();
    const generation = { sessionId: target.sessionId, lifecycleRevision: undefined };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
      { sessionId: target.sessionId, updatedAt: 2 },
    );

    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: generation,
        text: "This still belongs to the revision-less session.",
        idempotencyKey: "cron-current-completion:cron:job-legacy:4000",
        provenance: { kind: "cron", jobId: "job-legacy", runId: "cron:job-legacy:4000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: true });

    await replaceSessionEntry(
      { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
      { sessionId: target.sessionId, lifecycleRevision: "materialized-revision", updatedAt: 3 },
    );
    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: generation,
        text: "Do not append after the generation changes.",
        idempotencyKey: "cron-current-completion:cron:job-legacy:5000",
        provenance: { kind: "cron", jobId: "job-legacy", runId: "cron:job-legacy:5000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("session rebound") });
  });
});
