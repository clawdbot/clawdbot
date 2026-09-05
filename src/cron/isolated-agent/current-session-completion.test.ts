import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "../../gateway/managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
} from "../../sessions/session-lifecycle-admission.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createCliDeps } from "../isolated-agent.delivery.test-helpers.js";
import { commitCurrentSessionCronCompletion } from "./current-session-completion.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

async function createCompletionFixture(state: OpenClawTestState) {
  const sessionKey = "agent:main:webchat:direct:report";
  const sessionId = "report-session";
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(state.stateDir, "agents", "main", "sessions", "sessions.json"),
  };
  const generation = { sessionId, lifecycleRevision: "report-generation" };
  await replaceSessionEntry(scope, { ...generation, updatedAt: 1 });
  await fs.mkdir(state.workspaceDir, { recursive: true });
  const imagePath = path.join(state.workspaceDir, "report.png");
  await fs.writeFile(imagePath, PNG);
  const cfg = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    session: { store: scope.storePath },
  };
  const payload: ReplyPayload = { text: "Example report", mediaUrl: imagePath };
  const params: DispatchCronDeliveryParams = {
    cfg,
    cfgWithAgentDefaults: cfg,
    deps: createCliDeps(),
    job: makeCronJob({ id: "report-job", sessionTarget: "current", sessionKey }),
    agentId: "main",
    agentSessionKey: "agent:main:cron:report-job",
    sourceSessionKey: sessionKey,
    sourceSessionGeneration: generation,
    runSessionKey: "agent:main:cron:report-job:run:report-run",
    sessionId: "report-run",
    lifecycleRevision: "run-generation",
    sessionUpdatedAt: 1000,
    runStartedAt: 1000,
    runEndedAt: 2000,
    timeoutMs: 30000,
    resolvedDelivery: { ok: false, mode: "implicit", error: new Error("No external channel") },
    deliveryRequested: true,
    undeliveredRunStatus: "ok",
    spawnOnlyHandoff: false,
    sourceDeliveryOutcome: {
      visibleDeliveries: [],
      verifiedMessageToolDelivery: false,
      satisfiesSourceDelivery: false,
      unverifiedMessageToolDelivery: false,
    },
    deliveryBestEffort: false,
    deliveryPayloadHasStructuredContent: true,
    deliveryPayloads: [payload],
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: (result) => ({ ...result, sessionId: "report-run" }),
  };
  const records = () => listManagedImageRecordEntries({ stateDir: state.stateDir, sessionKey });
  const downloads: Array<ReturnType<typeof resolveManagedOutgoingMediaArtifactDownload>> = [];
  let updates = 0;
  const unsubscribe = onSessionTranscriptUpdate((update) => {
    if (update.target.sessionId !== sessionId) {
      return;
    }
    updates += 1;
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
  return {
    payload,
    params,
    scope,
    records,
    downloads,
    updates: () => updates,
    unsubscribe,
    commit: () => commitCurrentSessionCronCompletion(params),
    messages: async () =>
      (await loadTranscriptEvents(scope)).filter(
        (event) => readTranscriptEventMessage(event)?.role === "assistant",
      ),
  };
}

describe("current-session completion media", () => {
  it.each(["ordinary", "promotion-failure"] as const)(
    "publishes downloadable media and replays the original message after %s",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state);
        const database = openOpenClawStateDatabase({ env: state.env });
        try {
          if (mode === "promotion-failure") {
            database.db.exec(`CREATE TEMP TRIGGER fail_report_promotion
              BEFORE UPDATE OF message_id ON managed_outgoing_image_records
              BEGIN SELECT RAISE(ABORT, 'report promotion failed'); END`);
            await expect(fixture.commit()).rejects.toThrow("report promotion failed");
            expect(fixture.updates()).toBe(0);
            database.db.exec("DROP TRIGGER fail_report_promotion");
          } else {
            await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
          }
          const original = await fixture.messages();
          const originalIds = fixture.records().map(({ record }) => record.attachmentId);
          expect(original).toHaveLength(1);
          await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
          expect(await fixture.messages()).toEqual(original);
          expect(fixture.records().map(({ record }) => record.attachmentId)).toEqual(originalIds);
          expect(fixture.updates()).toBeGreaterThan(0);
          for (const { record } of fixture.records()) {
            expect(record).toMatchObject({
              messageId: readTranscriptEventId(original[0]),
              retentionClass: "history",
            });
            await expect(
              fs.readFile(
                path.join(
                  record.original.mediaRoot,
                  record.original.mediaSubdir,
                  record.original.mediaId,
                ),
              ),
            ).resolves.toEqual(PNG);
          }
          expect(fixture.downloads.length).toBeGreaterThan(0);
          for (const download of await Promise.all(fixture.downloads)) {
            expect(download).toMatchObject({ type: "image" });
          }
        } finally {
          database.db.exec("DROP TRIGGER IF EXISTS fail_report_promotion");
          fixture.unsubscribe();
        }
      });
    },
  );

  it("keeps structured report text in both model and display history", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state);
      try {
        fixture.payload.presentation = {
          blocks: [
            {
              type: "table",
              caption: "Revenue",
              headers: ["Quarter", "Revenue"],
              rows: [["Q1", 10]],
            },
          ],
        };
        await fixture.commit();
        const message = readTranscriptEventMessage((await fixture.messages())[0]);
        expect(message?.content).toEqual([
          {
            type: "text",
            text: "Example report\nRevenue (table)\n- Quarter: Q1; Revenue: 10\nreport.png",
          },
        ]);
        expect(readAssistantDisplayContent(message)).toEqual([
          { type: "text", text: "Example report\nRevenue (table)\n- Quarter: Q1; Revenue: 10" },
          expect.objectContaining({ type: "image" }),
        ]);
      } finally {
        fixture.unsubscribe();
      }
    });
  });

  it.each(["text-only", "missing-image", "media-only"] as const)(
    "preserves the completed result for %s output",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state);
        try {
          if (mode === "text-only") {
            fixture.params.deliveryPayloads = [{ text: "Final report" }];
          } else if (mode === "missing-image") {
            await fs.unlink(path.join(state.workspaceDir, "report.png"));
          } else {
            fixture.payload.text = undefined;
          }
          await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
          const message = readTranscriptEventMessage((await fixture.messages())[0]);
          if (mode === "media-only") {
            expect(readAssistantDisplayContent(message)).toEqual([
              expect.objectContaining({ type: "image" }),
            ]);
            expect(fixture.records()).toHaveLength(1);
          } else {
            expect(message?.content).toEqual([
              {
                type: "text",
                text: mode === "text-only" ? "Final report" : "Example report\nreport.png",
              },
            ]);
            if (mode === "missing-image") {
              expect(readAssistantDisplayContent(message)).toEqual([
                { type: "text", text: "Example report" },
                expect.objectContaining({
                  type: "attachment_error",
                  attachment: expect.objectContaining({
                    label: "report.png",
                    code: "delivery-failed",
                  }),
                }),
              ]);
            } else {
              expect(message).not.toHaveProperty("openclawDisplayContent");
            }
            expect(fixture.records()).toEqual([]);
          }
        } finally {
          fixture.unsubscribe();
        }
      });
    },
  );

  it("preserves interleaved report text, media, and spoken-payload failure metadata", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state);
      try {
        const secondImage = path.join(state.workspaceDir, "second.png");
        await fs.writeFile(secondImage, PNG);
        fixture.params.deliveryPayloads.push(
          setReplyPayloadMetadata(
            {
              spokenText: "Second report",
              mediaUrl: secondImage,
            },
            {
              assistantMediaFailures: [
                { code: "file-not-found", kind: "image", label: "missing.png" },
              ],
            },
          ),
        );
        await fixture.commit();
        const message = readTranscriptEventMessage((await fixture.messages())[0]);
        expect(readAssistantDisplayContent(message)).toEqual([
          { type: "text", text: "Example report" },
          expect.objectContaining({ type: "image", alt: "report.png" }),
          { type: "text", text: "Second report" },
          expect.objectContaining({ type: "image", alt: "second.png" }),
          expect.objectContaining({
            type: "attachment_error",
            attachment: expect.objectContaining({ label: "missing.png" }),
          }),
        ]);
      } finally {
        fixture.unsubscribe();
      }
    });
  });

  it.each([true, false])(
    "obeys workspaceOnly=%s for images beside the session store",
    async (workspaceOnly) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state);
        try {
          const privateImage = path.join(path.dirname(fixture.scope.storePath), "private.png");
          await fs.mkdir(path.dirname(privateImage), { recursive: true });
          await fs.writeFile(privateImage, PNG);
          fixture.params.cfgWithAgentDefaults.tools = { profile: "full", fs: { workspaceOnly } };
          fixture.params.deliveryPayloads = [{ text: "Report", mediaUrl: privateImage }];
          await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
          const message = readTranscriptEventMessage((await fixture.messages())[0]);
          const content = readAssistantDisplayContent(message);
          expect(content).toEqual([
            { type: "text", text: "Report" },
            expect.objectContaining({ type: workspaceOnly ? "attachment_error" : "image" }),
          ]);
          expect(fixture.records()).toHaveLength(workspaceOnly ? 0 : 1);
        } finally {
          fixture.unsubscribe();
        }
      });
    },
  );

  it("does not prepare media when the source generation changes while waiting", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state);
      const admission = await beginSessionWorkAdmission({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
        assertAllowed: () => {},
      });
      const commit = fixture.commit();
      try {
        await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBe(1));
        expect(fixture.records()).toEqual([]);
        await replaceSessionEntry(fixture.scope, {
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-generation",
          updatedAt: 3000,
        });
        admission.release();
        await expect(commit).resolves.toMatchObject({ ok: false });
        expect(fixture.records()).toEqual([]);
        expect(await fixture.messages()).toEqual([]);
        expect(fixture.updates()).toBe(0);
      } finally {
        admission.release();
        await commit;
        fixture.unsubscribe();
      }
    });
  });
});
