import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readRuntimeImageHistory } from "@openclaw/media-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  detectAndLoadPromptImages,
  hydratePromptMediaMessages,
} from "../../agents/embedded-agent-runner/run/images.js";
import { prepareEmbeddedAttemptPromptExecution } from "../../agents/embedded-agent-runner/run/prompt-image-preparation.js";
import {
  listSessionPendingInputs,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { getDefaultMediaLocalRoots } from "../../media/local-roots.js";
import { normalizeMediaFacts, readPersistedMediaFacts } from "../../media/media-facts.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { isUserMessage } from "../../sessions/user-turn-transcript.message.js";
import { readPersistedMediaImageLayout } from "../../sessions/user-turn-transcript.metadata.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildInboundMediaNoteProjection } from "../media-note.js";
import type { RuntimeMsgContext } from "../templating.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";
import { buildPersistedMediaImageLayout } from "./get-reply-run-helpers.js";
import {
  admitFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type InternalFollowupRun,
} from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

const HISTORY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const FIRST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);
// Existing native media-ref fixture; distinct from the two RGB pixels above.
const SECOND_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
  "base64",
);

function imageHash(image: { data: string }): string {
  return createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
}

describe("collected history with managed current images", () => {
  it("keeps current managed image bytes when retained history overlaps", async () => {
    await withTestDir({ prefix: "openclaw-queue-history-local-media-" }, async (base) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: base }, async () => {
        const inboundDir = path.join(base, "media", "inbound");
        const workspaceDir = path.join(base, "workspace");
        await Promise.all([
          fs.mkdir(inboundDir, { recursive: true }),
          fs.mkdir(workspaceDir, { recursive: true }),
        ]);
        const historyPath = path.join(inboundDir, "history.png");
        await Promise.all([
          fs.writeFile(historyPath, HISTORY_PNG),
          fs.writeFile(path.join(inboundDir, "first.png"), FIRST_PNG),
          fs.writeFile(path.join(inboundDir, "second.png"), SECOND_PNG),
        ]);
        const expectedHashes = [HISTORY_PNG, FIRST_PNG, SECOND_PNG].map((bytes) =>
          createHash("sha256").update(bytes).digest("hex"),
        );
        expect(new Set(expectedHashes).size).toBe(3);
        const key = `queue-history-local-media:${base}`;
        const now = 1_800_000_000_000;
        const localRoots = getDefaultMediaLocalRoots();
        expect(localRoots).toContain(path.join(base, "media"));
        const turns: InternalFollowupRun[] = [];
        try {
          for (const index of [0, 1]) {
            const ctx: RuntimeMsgContext = {
              Body: `question ${index + 1}`,
              Timestamp: now,
              media:
                index === 0
                  ? [
                      { url: "media://inbound/first.png", contentType: "image/png" },
                      { url: "media://inbound/second.png", contentType: "image/png" },
                    ]
                  : [],
              InboundHistory: [
                {
                  sender: "Ada",
                  body: "A retained photo.",
                  timestamp: now - 1_000,
                  messageId: "history-image",
                  media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
                },
              ],
            };
            const current = await resolveCurrentTurnImages({ ctx, cfg: {} });
            expect(current.images?.map(imageHash)).toEqual([expectedHashes[0]]);
            expect(current.imageOrder).toEqual(["inline"]);
            expect(current.unresolvedSourceIndexes ?? []).toEqual([]);
            expect(current.imageSourceIndexes).toEqual([-1]);
            const projection = buildInboundMediaNoteProjection(ctx);
            const inboundMediaIndexes = projection.mediaIndexes ?? [];
            const promptSourceIndexes = current.imageSourceIndexes?.map((sourceIndex) => {
              const promptIndex =
                sourceIndex === undefined ? -1 : inboundMediaIndexes.indexOf(sourceIndex);
              return promptIndex >= 0 ? promptIndex : undefined;
            });
            const mediaImageLayout = buildPersistedMediaImageLayout({
              ctx: {},
              media: projection.media,
              ctxMediaCount: inboundMediaIndexes.length,
              imageOrder: current.imageOrder,
              imageSourceIndexes: promptSourceIndexes,
            });
            expect(mediaImageLayout).toEqual(
              index === 0
                ? {
                    slots: [
                      { kind: "inline" },
                      { kind: "offloaded", factIndex: 0 },
                      { kind: "offloaded", factIndex: 1 },
                    ],
                  }
                : undefined,
            );
            const turn: InternalFollowupRun = {
              ...createQueueTestRun({
                prompt: [projection.text, ctx.Body].filter(Boolean).join("\n"),
              }),
              ...current,
              currentTurnImagesPrepared: true,
              media: projection.media,
              mediaImageLayout,
            };
            const loaded = await detectAndLoadPromptImages({
              prompt: turn.prompt,
              media: turn.media,
              existingImages: turn.images,
              imageOrder: turn.imageOrder,
              mediaImageLayout: turn.mediaImageLayout,
              model: { input: ["text", "image"] },
              workspaceDir,
              localRoots,
              workspaceOnly: true,
            });
            expect(loaded.images.map(imageHash)).toEqual(
              index === 0 ? expectedHashes : expectedHashes.slice(0, 1),
            );
            expect(loaded.imageFactIndexes).toEqual(index === 0 ? [null, 0, 1] : [null]);
            expect(loaded.failedMediaCount).toBe(0);
            expect(loaded.skippedCount).toBe(0);
            expect(loaded.loadedCount).toBe(index === 0 ? 2 : 0);
            turns.push(turn);
            expect(enqueueFollowupRun(key, turn, { mode: "collect", debounceMs: 0 })).toBe(true);
          }
          const drained = createDeferred<InternalFollowupRun>();
          let deliveries = 0;
          scheduleFollowupDrain(key, async (run) => {
            deliveries += 1;
            drained.resolve(run);
          });
          const collected = await drained.promise;
          await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
          expect(deliveries).toBe(1);
          expect(collected.prompt).toContain("question 1");
          expect(collected.prompt).toContain("question 2");
          expect(collected.currentTurnImagesPrepared).toBe(true);
          expect(collected.images?.map(imageHash)).toEqual([expectedHashes[0]]);
          expect(collected.media).toEqual(turns.flatMap((turn) => turn.media ?? []));
          const loaded = await detectAndLoadPromptImages({
            prompt: collected.prompt,
            media: collected.media,
            existingImages: collected.images,
            imageOrder: collected.imageOrder,
            mediaImageLayout: collected.mediaImageLayout,
            model: { input: ["text", "image"] },
            workspaceDir,
            localRoots,
            workspaceOnly: true,
          });
          expect(loaded.failedMediaCount).toBe(0);
          expect(loaded.skippedCount).toBe(0);
          expect({
            imageHashes: loaded.images.map(imageHash),
            imageFactIndexes: loaded.imageFactIndexes,
            loadedCount: loaded.loadedCount,
            layout: collected.mediaImageLayout,
          }).toEqual({
            imageHashes: expectedHashes,
            imageFactIndexes: [null, 0, 1],
            loadedCount: 2,
            layout: {
              slots: [
                { kind: "inline" },
                { kind: "offloaded", factIndex: 0 },
                { kind: "offloaded", factIndex: 1 },
              ],
              suppressedFactIndexes: [],
            },
          });
        } finally {
          clearFollowupQueue(key);
        }
      });
    });
  });

  it.each(["inline-first", "file-first"])(
    "keeps distinct inline and file images without optional layouts (%s)",
    async (order) => {
      await withTestDir({ prefix: "openclaw-queue-optional-images-" }, async (base) => {
        await withEnvAsync({ OPENCLAW_STATE_DIR: base }, async () => {
          const inboundDir = path.join(base, "media", "inbound");
          const workspaceDir = path.join(base, "workspace");
          await Promise.all([
            fs.mkdir(inboundDir, { recursive: true }),
            fs.mkdir(workspaceDir, { recursive: true }),
          ]);
          await fs.writeFile(path.join(inboundDir, "second.png"), SECOND_PNG);
          const inline: InternalFollowupRun = {
            ...createQueueTestRun({ prompt: "Inline image turn" }),
            images: [{ type: "image", data: FIRST_PNG.toString("base64"), mimeType: "image/png" }],
          };
          const file: InternalFollowupRun = {
            ...createQueueTestRun({ prompt: "File image turn" }),
            media: [{ url: "media://inbound/second.png", contentType: "image/png" }],
          };
          const localRoots = getDefaultMediaLocalRoots();
          const load = (turn: InternalFollowupRun) =>
            detectAndLoadPromptImages({
              prompt: turn.prompt,
              media: turn.media,
              existingImages: turn.images,
              imageOrder: turn.imageOrder,
              mediaImageLayout: turn.mediaImageLayout,
              model: { input: ["text", "image"] },
              workspaceDir,
              localRoots,
              workspaceOnly: true,
            });
          const expectedHashes = [FIRST_PNG, SECOND_PNG].map((bytes) =>
            createHash("sha256").update(bytes).digest("hex"),
          );
          const inputs = [inline, file];
          for (const [index, turn] of inputs.entries()) {
            expect(turn.currentTurnImagesPrepared).toBeUndefined();
            expect(turn.imageOrder).toBeUndefined();
            expect(turn.mediaImageLayout).toBeUndefined();
            const before = await load(turn);
            expect(before.images.map(imageHash)).toEqual([expectedHashes[index]]);
            expect(before.imageFactIndexes).toEqual([index === 0 ? null : 0]);
            expect(before.failedMediaCount).toBe(0);
            expect(before.skippedCount).toBe(0);
            expect(before.loadedCount).toBe(index);
          }
          const key = `queue-optional-images:${base}`;
          try {
            for (const turn of order === "inline-first" ? inputs : inputs.toReversed()) {
              expect(enqueueFollowupRun(key, turn, { mode: "collect", debounceMs: 0 })).toBe(true);
            }
            const drained = createDeferred<InternalFollowupRun>();
            let deliveries = 0;
            scheduleFollowupDrain(key, async (turn) => {
              deliveries += 1;
              drained.resolve(turn);
            });
            const collected = await drained.promise;
            await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
            expect(deliveries).toBe(1);
            expect(collected.prompt).toContain(inline.prompt);
            expect(collected.prompt).toContain(file.prompt);
            const after = await load(collected);
            expect(after.failedMediaCount).toBe(0);
            expect(after.skippedCount).toBe(0);
            expect({
              images: after.images
                .map((image, index) => ({
                  hash: imageHash(image),
                  factIndex: after.imageFactIndexes[index],
                }))
                .toSorted((left, right) => left.hash.localeCompare(right.hash)),
              loadedCount: after.loadedCount,
            }).toEqual({
              images: expectedHashes
                .map((hash, index) => ({ hash, factIndex: index === 0 ? null : 0 }))
                .toSorted((left, right) => left.hash.localeCompare(right.hash)),
              loadedCount: 1,
            });
          } finally {
            clearFollowupQueue(key);
          }
        });
      });
    },
  );
});

describe("collected images through embedded transcript preparation", () => {
  const fixture = useTempSessionsFixture("openclaw-queue-embedded-media-");

  it.each([
    {
      scenario: "history-first",
      order: "history-first",
      historyOnly: false,
      currentOffloaded: false,
      omitCurrentLayout: false,
    },
    {
      scenario: "current-first",
      order: "current-first",
      historyOnly: false,
      currentOffloaded: false,
      omitCurrentLayout: false,
    },
    {
      scenario: "history-only-inline-history-first",
      order: "history-first",
      historyOnly: true,
      currentOffloaded: false,
      omitCurrentLayout: false,
    },
    {
      scenario: "history-only-inline-current-first",
      order: "current-first",
      historyOnly: true,
      currentOffloaded: false,
      omitCurrentLayout: false,
    },
    {
      scenario: "history-only-offloaded-history-first",
      order: "history-first",
      historyOnly: true,
      currentOffloaded: true,
      omitCurrentLayout: false,
    },
    {
      scenario: "history-only-offloaded-current-first",
      order: "current-first",
      historyOnly: true,
      currentOffloaded: true,
      omitCurrentLayout: false,
    },
    {
      scenario: "history-only-inline-no-layout-history-first",
      order: "history-first",
      historyOnly: true,
      currentOffloaded: false,
      omitCurrentLayout: true,
    },
    {
      scenario: "history-only-inline-no-layout-current-first",
      order: "current-first",
      historyOnly: true,
      currentOffloaded: false,
      omitCurrentLayout: true,
    },
  ] as const)(
    "retains image ownership through collected embedded preparation ($scenario)",
    async ({ scenario, order, historyOnly, currentOffloaded, omitCurrentLayout }) => {
      const base = path.resolve(fixture.sessionsDir(), "../../..");
      await withEnvAsync({ OPENCLAW_STATE_DIR: base }, async () => {
        const inboundDir = path.join(base, "media", "inbound");
        const workspaceDir = path.join(base, "workspace");
        await Promise.all([
          fs.mkdir(inboundDir, { recursive: true }),
          fs.mkdir(workspaceDir, { recursive: true }),
        ]);
        const historyPath = path.join(inboundDir, "history.png");
        const currentPath = path.join(inboundDir, "current-c.png");
        const audioPath = path.join(inboundDir, "transcribed.wav");
        await Promise.all([
          fs.writeFile(historyPath, HISTORY_PNG),
          fs.writeFile(path.join(inboundDir, "current-a.png"), FIRST_PNG),
          fs.writeFile(currentPath, SECOND_PNG),
          // A valid empty WAV header; this already-transcribed audio is never read as an image.
          fs.writeFile(
            audioPath,
            Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=", "base64"),
          ),
        ]);
        const hashes = [HISTORY_PNG, FIRST_PNG, SECOND_PNG].map((bytes) =>
          createHash("sha256").update(bytes).digest("hex"),
        );
        expect(new Set(hashes).size).toBe(3);
        const sessionKey = `agent:main:queue-embedded-media-${scenario}`;
        const sessionId = `queue-embedded-media-${scenario}`;
        const config = { session: { store: fixture.storePath() } };
        const scope = {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: fixture.storePath(),
        };
        const recorders: UserTurnTranscriptRecorder[] = [];
        const prepare = (run: InternalFollowupRun) =>
          prepareEmbeddedAttemptPromptExecution({
            attempt: {
              config,
              model: { input: ["text", "image"] },
              images: run.images,
              imageOrder: run.imageOrder,
              media: run.media,
              userTurnTranscriptRecorder: run.userTurnTranscriptRecorder,
            },
            mediaOwnerAgentId: "main",
            effectiveFsWorkspaceOnly: false,
            effectiveWorkspace: workspaceDir,
            prompt: run.prompt,
            skipPromptSubmission: false,
          });
        type Prepared = Awaited<ReturnType<typeof prepare>>;
        const observe = (result: Prepared) => ({
          imageHashes: result.images.map(imageHash),
          imageFactIndexes: result.imageFactIndexes,
          loadedCount: result.loadedCount,
          failedMediaCount: result.failedMediaCount,
          skippedCount: result.skippedCount,
        });
        const sources: Array<{
          name: "history" | "current";
          run: InternalFollowupRun;
          media: ReturnType<typeof normalizeMediaFacts>;
          before: Prepared;
        }> = [];
        try {
          await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
          const now = 1_800_000_000_000;
          for (const name of ["history", "current"] as const) {
            const ctx: RuntimeMsgContext = {
              Body:
                name === "history"
                  ? historyOnly
                    ? "retained history only"
                    : "history and current A"
                  : "ordinary current C",
              Timestamp: now,
              media:
                name === "history"
                  ? historyOnly
                    ? []
                    : [
                        { path: audioPath, contentType: "audio/wav" },
                        { url: "media://inbound/current-a.png", contentType: "image/png" },
                      ]
                  : [
                      currentOffloaded
                        ? { url: "media://inbound/current-c.png", contentType: "image/png" }
                        : { path: currentPath, contentType: "image/png" },
                    ],
              ...(name === "history"
                ? {
                    ...(historyOnly
                      ? {}
                      : {
                          MediaUnderstanding: [
                            {
                              kind: "audio.transcription" as const,
                              attachmentIndex: 0,
                              provider: "fixture",
                              text: "The audio has already been transcribed.",
                            },
                          ],
                        }),
                    InboundHistory: [
                      {
                        sender: "Ada",
                        body: "A retained photo.",
                        timestamp: now - 1_000,
                        messageId: "retained-h",
                        media: [
                          {
                            path: historyPath,
                            contentType: "image/png",
                            kind: "image" as const,
                          },
                        ],
                      },
                    ],
                  }
                : {}),
            };
            const current = await resolveCurrentTurnImages({ ctx, cfg: config });
            expect(current.images?.map(imageHash) ?? []).toEqual(
              name === "history" ? [hashes[0]] : currentOffloaded ? [] : [hashes[2]],
            );
            expect(current.imageOrder ?? []).toEqual(
              name === "current" && currentOffloaded ? [] : ["inline"],
            );
            expect(Boolean(readRuntimeImageHistory(current.images?.[0]))).toBe(name === "history");
            expect(current.unresolvedSourceIndexes ?? []).toEqual([]);
            const media = normalizeMediaFacts(ctx.media);
            const projection = buildInboundMediaNoteProjection(ctx);
            expect(projection.mediaIndexes ?? []).toEqual(
              name === "history" ? (historyOnly ? [] : [1]) : [0],
            );
            const persistedLayout = buildPersistedMediaImageLayout({
              ctx,
              media,
              ctxMediaCount: media.length,
              imageOrder: current.imageOrder,
              imageSourceIndexes: current.imageSourceIndexes,
            });
            const promptLayout = buildPersistedMediaImageLayout({
              ctx: {},
              media: projection.media,
              ctxMediaCount: projection.mediaIndexes?.length ?? 0,
              imageOrder: current.imageOrder,
              // Match production: -1 forbids binding history to a projected current fact.
              imageSourceIndexes: current.imageSourceIndexes?.map((sourceIndex) =>
                sourceIndex === undefined
                  ? undefined
                  : (projection.mediaIndexes ?? []).indexOf(sourceIndex),
              ),
            });
            if (name === "history" && historyOnly) {
              expect(media).toEqual([]);
              expect(persistedLayout).toBeUndefined();
              expect(promptLayout).toBeUndefined();
            }
            const messageId = `${scenario}-${name}`;
            const recorder = createUserTurnTranscriptRecorder({
              input: {
                text: ctx.Body,
                media,
                mediaImageLayout:
                  name === "current" && omitCurrentLayout ? undefined : persistedLayout,
                idempotencyKey: `${messageId}:user`,
              },
              target: createTestUserTurnTranscriptTarget({
                ...scope,
                config,
                cwd: workspaceDir,
              }),
              updateMode: "none",
            });
            recorders.push(recorder);
            expect(
              await recorder.stageApproved?.({ runId: messageId, assertCurrent: () => {} }),
            ).toBe(true);
            const template = createQueueTestRun({
              prompt: [projection.text, ctx.Body].filter(Boolean).join("\n"),
              messageId,
            });
            const run: InternalFollowupRun = {
              ...template,
              ...current,
              currentTurnImagesPrepared: true,
              media: projection.media,
              mediaImageLayout: name === "current" && omitCurrentLayout ? undefined : promptLayout,
              transcriptPrompt: ctx.Body,
              userTurnTranscriptRecorder: recorder,
              run: {
                ...template.run,
                agentId: "main",
                sessionId,
                sessionKey,
                sessionFile: sessionKey,
                agentDir: path.join(base, "agents", "main", "agent"),
                workspaceDir,
                config,
              },
            };
            const sourceMessage = await recorder.resolveMessage();
            if (!sourceMessage) {
              throw new Error("source recorder did not resolve its admitted input");
            }
            const persistedMedia = readPersistedMediaFacts(sourceMessage) ?? [];
            expect(persistedMedia).toEqual(media);
            if ((name === "history" && historyOnly) || (name === "current" && omitCurrentLayout)) {
              expect(readPersistedMediaImageLayout(sourceMessage)).toBeUndefined();
            }
            const before = await prepare(run);
            expect(observe(before)).toEqual({
              imageHashes:
                name === "history" ? hashes.slice(0, historyOnly ? 1 : 2) : hashes.slice(2),
              imageFactIndexes: name === "history" ? (historyOnly ? [null] : [null, 1]) : [0],
              loadedCount: name === "history" ? (historyOnly ? 0 : 1) : currentOffloaded ? 1 : 0,
              failedMediaCount: 0,
              skippedCount: 0,
            });
            sources.push({ name, run, media: persistedMedia, before });
          }
          expect(listSessionPendingInputs(scope).total).toBe(2);
          const ordered = order === "history-first" ? sources : sources.toReversed();
          const expectedMedia = ordered.flatMap((source) => source.media);
          let mediaOffset = 0;
          const expectedIndexes = ordered.flatMap((source) => {
            const indexes = source.before.imageFactIndexes.map((index) =>
              index === null ? null : index + mediaOffset,
            );
            mediaOffset += source.media.length;
            return indexes;
          });
          const results: Array<{
            run: InternalFollowupRun;
            result: Prepared;
            message: PersistedUserTurnMessage;
          }> = [];
          const failures: unknown[] = [];
          const drained = createDeferred();
          for (const source of ordered) {
            expect(
              enqueueFollowupRun(sessionKey, source.run, { mode: "collect", debounceMs: 0 }),
            ).toBe(true);
          }
          scheduleFollowupDrain(sessionKey, async (run) => {
            try {
              await admitFollowupRunLifecycle(run);
              const recorder = run.userTurnTranscriptRecorder;
              if (!recorder?.withPendingInput) {
                throw new Error("collected turn has no real transcript owner");
              }
              const result = await prepare(run);
              const persisted = await recorder.withPendingInput(() => recorder.persistApproved());
              if (!persisted) {
                throw new Error("collected transcript did not persist");
              }
              results.push({ run, result, message: persisted.message });
            } catch (error) {
              failures.push(error);
            } finally {
              drained.resolve();
            }
          });
          await drained.promise;
          await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());
          expect(failures).toEqual([]);
          expect(results).toHaveLength(1);
          const collected = results[0];
          if (!collected) {
            throw new Error("collect queue did not produce its one followup");
          }
          expect(collected.run.prompt).toContain(
            historyOnly ? "retained history only" : "history and current A",
          );
          expect(collected.run.prompt).toContain("ordinary current C");
          expect(listSessionPendingInputs(scope).total).toBe(0);
          expect(readPersistedMediaFacts(collected.message)).toEqual(expectedMedia);
          const stored = (await loadTranscriptEvents(scope))
            .filter(isRecord)
            .filter((event) => event.type === "message");
          expect(stored).toHaveLength(1);
          const storedMessage = stored[0]?.message;
          if (!isUserMessage(storedMessage) || typeof storedMessage.content !== "string") {
            throw new Error(
              "collected text-only user turn is absent from the real transcript store",
            );
          }
          expect(readPersistedMediaFacts(storedMessage)).toEqual(expectedMedia);
          expect(observe(collected.result)).toEqual({
            imageHashes: ordered.flatMap((source) => source.before.images.map(imageHash)),
            imageFactIndexes: expectedIndexes,
            loadedCount: sources.reduce((count, source) => count + source.before.loadedCount, 0),
            failedMediaCount: 0,
            skippedCount: 0,
          });
          const replayFailures: number[] = [];
          const [replayed] = await hydratePromptMediaMessages([storedMessage], {
            workspaceDir,
            model: { input: ["text", "image"] },
            localRoots: getDefaultMediaLocalRoots(),
            onCurrentTurnImageFailure: (count) => {
              replayFailures.push(count);
            },
          });
          if (replayed?.role !== "user" || !Array.isArray(replayed.content)) {
            throw new Error("stored collected turn was not materialized for replay");
          }
          expect({
            imageHashes: replayed.content.filter((block) => block.type === "image").map(imageHash),
            text: replayed.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
            failures: replayFailures,
          }).toEqual({
            imageHashes: ordered.flatMap((source) =>
              source.name === "history" ? (historyOnly ? [] : [hashes[1]]) : [hashes[2]],
            ),
            text: [storedMessage.content],
            failures: [],
          });
        } finally {
          clearFollowupQueue(sessionKey);
          for (const recorder of recorders) {
            recorder.finishPendingInput?.("interrupted");
          }
          closeOpenClawAgentDatabasesForTest();
        }
      });
    },
  );
});
