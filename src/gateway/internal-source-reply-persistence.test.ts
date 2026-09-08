import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedAttemptTranscriptLifecycle } from "../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { persistInternalSourceReply } from "./internal-source-reply-persistence.js";
import {
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  removeManagedOutgoingMediaBlocks,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  claimManagedImageRecordCleanupIfCurrent,
  listManagedImageRecordEntries,
} from "./managed-image-record-store.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

async function createSourceReplyFixture(state: OpenClawTestState) {
  const sessionKey = "agent:main:webchat:dm:partial-promotion";
  const sessionId = "partial-promotion-session";
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(state.stateDir, "agents", "main", "sessions", "sessions.json"),
  };
  const entry = {
    sessionId,
    updatedAt: 1,
    lifecycleRevision: "initial-lifecycle",
    activeWriterRunId: "original-run",
  };
  const imagePaths = ["first.png", "second.png"].map((name) => path.join(state.workspaceDir, name));
  await fs.mkdir(state.workspaceDir, { recursive: true });
  await Promise.all(
    imagePaths.map((file) => fs.writeFile(file, Buffer.from(TINY_PNG_BASE64, "base64"))),
  );
  await replaceSessionEntry(scope, entry);
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
  });
  const records = () => listManagedImageRecordEntries({ stateDir: state.stateDir, sessionKey });
  const updates: SessionTranscriptUpdate[] = [];
  const downloads: Array<ReturnType<typeof resolveManagedOutgoingMediaArtifactDownload>> = [];
  const unsubscribe = onSessionTranscriptUpdate((update) => {
    if (update.target.sessionId !== sessionId) {
      return;
    }
    updates.push(update);
    for (const { record } of records()) {
      downloads.push(
        resolveManagedOutgoingMediaArtifactDownload({
          sessionKey,
          agentId: "main",
          stateDir: state.stateDir,
          artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${record.attachmentId}`,
        }),
      );
    }
  });
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ sessionId });
  let failDrain = false;
  let onQueued: (() => void) | undefined;
  const persist = (options: { sessionKey?: string; runId?: string; textOnly?: boolean } = {}) =>
    withOwnedSessionTranscriptWrites(
      {
        sessionKey,
        sessionTarget: {
          ...scope,
          expectedLifecycleRevision: entry.lifecycleRevision,
          expectedWriterRunId: entry.activeWriterRunId,
        },
        withTranscriptWrite: (run) => {
          onQueued?.();
          onQueued = undefined;
          return lifecycle.withTranscriptWrite(async () => {
            const result = await run();
            if (failDrain) {
              failDrain = false;
              void lifecycle
                .withTranscriptWrite(() => {
                  throw new Error("nested drain failed");
                })
                .catch(() => {});
            }
            return result;
          });
        },
      },
      () =>
        persistInternalSourceReply({
          cfg: { agents: { entries: { main: { default: true, workspace: state.workspaceDir } } } },
          sessionKey: options.sessionKey ?? sessionKey,
          expectedSessionId: sessionId,
          agentId: "main",
          idempotencyKey: "partial-promotion-reply",
          sourceReplyFinal: true,
          runId: options.runId ?? "original-run",
          payload: {
            text: "Source reply",
            ...(options.textOnly
              ? {}
              : {
                  mediaUrls: imagePaths,
                  attachments: [{ name: "first.png" }, { name: "second.png" }],
                  trustedLocalMedia: true,
                }),
          },
        }),
    );
  const removePromotionFault = () =>
    database.db.exec("DROP TRIGGER IF EXISTS fail_second_media_promotion");
  return {
    state,
    scope,
    entry,
    records,
    updates,
    downloads,
    persist,
    events: () => loadTranscriptEvents(scope),
    failNextDrain: () => {
      failDrain = true;
    },
    failSecondPromotion: () =>
      database.db.exec(`CREATE TEMP TRIGGER fail_second_media_promotion
      BEFORE UPDATE OF message_id ON managed_outgoing_image_records
      WHEN OLD.original_filename = 'second.png' AND NEW.message_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'second media promotion failed'); END`),
    removePromotionFault,
    holdWrites: async () => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const done = lifecycle.withTranscriptWrite(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = createDeferredCore();
      onQueued = queued.resolve;
      return { queued: queued.promise, release: release.resolve, done };
    },
    dispose: async () => {
      unsubscribe();
      removePromotionFault();
      await lifecycle.dispose();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createSourceReplyFixture>>;

async function expectOriginalBytes(fixture: Fixture) {
  for (const { record } of fixture.records()) {
    await expect(
      fs.readFile(
        path.join(record.original.mediaRoot, record.original.mediaSubdir, record.original.mediaId),
      ),
    ).resolves.toEqual(Buffer.from(TINY_PNG_BASE64, "base64"));
  }
}

async function createPartialPromotion(fixture: Fixture) {
  fixture.failSecondPromotion();
  await expect(fixture.persist()).rejects.toThrow("second media promotion failed");
  const events = await fixture.events();
  const assistants = events.filter(
    (event) => readTranscriptEventMessage(event)?.role === "assistant",
  );
  expect(assistants).toHaveLength(1);
  const messageId = readTranscriptEventId(assistants[0]);
  expect(messageId).toBeTruthy();
  expect(fixture.records()).toHaveLength(2);
  expect(
    fixture.records().find(({ record }) => record.original.filename === "first.png")?.record,
  ).toMatchObject({ messageId, retentionClass: "history" });
  expect(
    fixture.records().find(({ record }) => record.original.filename === "second.png")?.record,
  ).toMatchObject({ messageId: null, retentionClass: "transient" });
  expect(fixture.updates).toEqual([]);
  await expectOriginalBytes(fixture);
  fixture.removePromotionFault();
  return { events, messageId };
}

describe("internal source reply persistence", () => {
  it.each(["partial-promotion", "owned-drain", "ordinary", "canonical-key", "text-only"] as const)(
    "completes exact replay and refreshes history after %s",
    async (mode) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "source-reply-replay-" },
        async (state) => {
          const fixture = await createSourceReplyFixture(state);
          try {
            if (mode === "partial-promotion") {
              await createPartialPromotion(fixture);
            } else if (mode === "owned-drain") {
              fixture.failNextDrain();
              await expect(fixture.persist()).rejects.toThrow("nested drain failed");
              expect(fixture.updates).toEqual([]);
              expect(
                fixture.records().every(({ record }) => record.retentionClass === "history"),
              ).toBe(true);
            } else {
              await fixture.persist({ textOnly: mode === "text-only" });
              expect(fixture.updates).toHaveLength(1);
            }
            const events = await fixture.events();
            const assistants = events.filter(
              (event) => readTranscriptEventMessage(event)?.role === "assistant",
            );
            expect(assistants).toHaveLength(1);
            expect(readTranscriptEventMessage(assistants[0])).toMatchObject({
              __openclaw: { runId: "original-run" },
            });
            const messageId = readTranscriptEventId(assistants[0]);
            const originalIds = fixture
              .records()
              .map(({ record }) => record.attachmentId)
              .toSorted();
            const beforeUpdates = fixture.updates.length;
            await expect(
              fixture.persist({
                runId: "retry-run",
                textOnly: mode === "text-only",
                ...(mode === "canonical-key"
                  ? { sessionKey: "AGENT:MAIN:webchat:dm:partial-promotion" }
                  : {}),
              }),
            ).resolves.toBeUndefined();
            expect(await fixture.events()).toEqual(events);
            expect(
              fixture
                .records()
                .map(({ record }) => record.attachmentId)
                .toSorted(),
            ).toEqual(originalIds);
            expect(fixture.updates).toHaveLength(beforeUpdates + 1);
            expect(fixture.updates.at(-1)?.message).toBeUndefined();
            expect(fixture.updates.filter((update) => update.message !== undefined)).toHaveLength(
              beforeUpdates,
            );
            expect(fixture.records()).toHaveLength(mode === "text-only" ? 0 : 2);
            for (const { record, cleanupPending } of fixture.records()) {
              expect(cleanupPending).toBe(false);
              expect(record).toMatchObject({ messageId, retentionClass: "history" });
            }
            await expectOriginalBytes(fixture);
            expect(fixture.downloads).toHaveLength(
              fixture.updates.length * (mode === "text-only" ? 0 : 2),
            );
            for (const download of await Promise.all(fixture.downloads)) {
              expect(download).toMatchObject({ type: "image" });
            }
          } finally {
            await fixture.dispose();
          }
        },
      );
    },
  );

  it.each([
    "session",
    "lifecycle",
    "writer",
    "abandoned",
    "removed",
    "missing-media",
    "cleanup-pending",
  ] as const)(
    "rejects replay after %s changes while its real owned write is queued",
    async (changed) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "source-reply-stale-" },
        async (state) => {
          const fixture = await createSourceReplyFixture(state);
          let held: Awaited<ReturnType<Fixture["holdWrites"]>> | undefined;
          let replay: Promise<void> | undefined;
          try {
            const original = await createPartialPromotion(fixture);
            held = await fixture.holdWrites();
            replay = fixture.persist({ runId: "retry-run" });
            await Promise.race([
              held.queued,
              replay.then(() => {
                throw new Error("replay completed before the owned queue");
              }),
            ]);
            if (changed === "session" || changed === "lifecycle" || changed === "writer") {
              await replaceSessionEntry(fixture.scope, {
                ...fixture.entry,
                ...(changed === "session" ? { sessionId: "replacement-session" } : {}),
                ...(changed === "lifecycle" ? { lifecycleRevision: "replacement-lifecycle" } : {}),
                ...(changed === "writer" ? { activeWriterRunId: "replacement-writer" } : {}),
              });
            } else if (changed === "abandoned") {
              await appendTranscriptMessage(fixture.scope, {
                eventId: "replacement-root",
                parentId: null,
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Replacement branch" }],
                },
              });
            } else if (changed === "removed") {
              await replaceTranscriptEvents(
                fixture.scope,
                original.events.filter(
                  (event) => readTranscriptEventId(event) !== original.messageId,
                ),
              );
            } else {
              const pending = fixture
                .records()
                .find(({ record }) => record.messageId === null)?.record;
              if (!pending) {
                throw new Error("expected second prepared media record");
              }
              if (changed === "cleanup-pending") {
                expect(claimManagedImageRecordCleanupIfCurrent(pending, state.stateDir)).toBe(true);
              } else {
                await removeManagedOutgoingMediaBlocks({
                  stateDir: state.stateDir,
                  messageId: null,
                  blocks: [
                    {
                      type: "image",
                      url: `/api/chat/media/outgoing/${encodeURIComponent(fixture.scope.sessionKey)}/${pending.attachmentId}/full`,
                    },
                  ],
                });
                expect(fixture.records()).toHaveLength(1);
              }
            }
            const beforeEvents = await fixture.events();
            const beforeRecords = fixture.records();
            held.release();
            await expect(replay).rejects.toThrow(
              changed === "missing-media" || changed === "cleanup-pending"
                ? "media ownership could not be persisted"
                : "no longer owns the active transcript",
            );
            await held.done;
            expect(await fixture.events()).toEqual(beforeEvents);
            expect(fixture.records()).toEqual(beforeRecords);
            expect(fixture.updates).toEqual([]);
            await expectOriginalBytes(fixture);
          } finally {
            held?.release();
            await held?.done;
            await replay?.catch(() => {});
            await fixture.dispose();
          }
        },
      );
    },
  );
});
