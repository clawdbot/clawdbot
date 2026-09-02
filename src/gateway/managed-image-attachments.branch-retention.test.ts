import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  listSessionBranches,
  loadTranscriptEventRowsAfterSeqSync,
  readSessionTranscriptRetentionFence,
  readSessionTranscriptWatermark,
  replaceTranscriptEvents,
  rewindSessionToMessage,
  rewriteTranscriptEventRowsExact,
  switchSessionBranch,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { restoreCompactionCheckpointSession } from "../config/sessions/session-accessor.sqlite-checkpoint.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  attachManagedOutgoingMediaToMessage,
  cleanupManagedOutgoingMediaRecords,
  handleManagedOutgoingMediaHttpRequest,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  insertManagedImageRecord,
  listManagedImageRecordEntries,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
} from "./managed-image-record-store.js";
import { rewriteAssistantTranscriptMessageByTurnIndexAndMedia } from "./server-methods/chat-transcript-persistence.js";
import { readSessionMessagesWithSourceAsync } from "./session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const agentId = "main";
const sessionKey = "agent:main:media-branch";
const sessionId = "media-branch-session";
const attachmentId = "3f5c9c0e-1f9a-4a2b-8b3d-5c7e9a1d2b4f";
const mediaId = "managed-branch.png";

let stateDir: string;
let mediaRoot: string;
let originalPath: string;

function mediaUrl(): string {
  return `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
}

async function seedSessionWithManagedImage() {
  const scope = { agentId, env: process.env, sessionId, sessionKey };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
  await appendTranscriptEvent(scope, {
    type: "session",
    id: sessionId,
    version: 3,
    timestamp: "2026-08-01T00:00:00.000Z",
  });
  const turns = [
    { id: "u1", parentId: null, message: { role: "user", content: "first prompt" } },
    { id: "a1", parentId: "u1", message: { role: "assistant", content: "first answer" } },
    { id: "u2", parentId: "a1", message: { role: "user", content: "draw me a chart" } },
    {
      id: "a2",
      parentId: "u2",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "here is the chart" },
          { type: "image", url: mediaUrl(), openUrl: mediaUrl(), mimeType: "image/png" },
        ],
      },
    },
    { id: "u3", parentId: "a2", message: { role: "user", content: "third prompt" } },
    { id: "a3", parentId: "u3", message: { role: "assistant", content: "third answer" } },
  ];
  let offset = 1;
  for (const turn of turns) {
    await appendTranscriptMessage(scope, {
      eventId: turn.id,
      message: turn.message,
      now: Date.parse("2026-08-01T00:00:00.000Z") + offset * 1000,
      parentId: turn.parentId,
    });
    offset += 1;
  }
}

async function commitManagedRecord(messageId: string | null) {
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.writeFile(originalPath, Buffer.from("89504e470d0a1a0a", "hex"));
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      agentId,
      messageId,
      createdAt: "2026-08-01T00:00:04.000Z",
      updatedAt: "2026-08-01T00:00:04.000Z",
      retentionClass: "history",
      alt: "chart",
      original: {
        mediaRoot,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        mediaId,
        contentType: "image/png",
        width: 8,
        height: 8,
        sizeBytes: 8,
        filename: mediaId,
      },
    },
    stateDir,
  );
}

async function readActiveMessages(): Promise<unknown[]> {
  const loaded = loadGatewaySessionEntryReadOnly(sessionKey, { agentId });
  const result = await readSessionMessagesWithSourceAsync(
    {
      agentId,
      sessionEntry: loaded.entry,
      sessionId: loaded.entry?.sessionId ?? sessionId,
      sessionKey,
      storePath: loaded.storePath,
    },
    { mode: "full", reason: "branch retention", allowResetArchiveFallback: true },
  );
  return result.messages;
}

async function pathExists(target: string): Promise<boolean> {
  return await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

async function fetchManagedArtifact(
  url: string,
  headers?: Record<string, string>,
): Promise<{ body: Buffer; status: number }> {
  const server = http.createServer((req, res) => {
    void handleManagedOutgoingMediaHttpRequest(req, res, {
      auth: { mode: "token", token: "test-token", allowTailscale: false },
      stateDir,
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { headers });
    return {
      body: Buffer.from(await response.arrayBuffer()),
      status: response.status,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function currentTranscriptScope() {
  const loaded = loadGatewaySessionEntryReadOnly(sessionKey, { agentId });
  return {
    agentId,
    env: process.env,
    sessionId: loaded.entry?.sessionId ?? sessionId,
    sessionKey,
    storePath: loaded.storePath,
  };
}

async function rewriteManagedMessageContent(content: unknown) {
  const scope = currentTranscriptScope();
  const watermark = readSessionTranscriptWatermark(scope);
  const row = loadTranscriptEventRowsAfterSeqSync(scope, -1).find(
    ({ event }) => (event as { id?: unknown }).id === "a2",
  );
  if (!row) {
    throw new Error("expected managed assistant transcript row");
  }
  const rewritten = await rewriteTranscriptEventRowsExact(scope, {
    expectedGeneration: watermark.generation,
    rows: [
      {
        event: {
          ...(row.event as Record<string, unknown>),
          message: { role: "assistant", content },
        },
        expectedEventJson: JSON.stringify(row.event),
        seq: row.seq,
      },
    ],
  });
  expect(rewritten).toEqual({ generation: expect.any(String) });
  return {
    after: readSessionTranscriptWatermark(scope),
    before: watermark,
  };
}

async function rewindPastManagedImage(): Promise<string> {
  const rewind = await rewindSessionToMessage({
    agentId,
    env: process.env,
    entryId: "u2",
    sessionKey,
  });
  expect(rewind.status).toBe("created");
  const branches = await listSessionBranches({ agentId, env: process.env, sessionKey });
  if (branches.status !== "ok") {
    throw new Error(`branch listing failed: ${branches.status}`);
  }
  const inactive = branches.branches.find((branch) => !branch.active);
  expect(inactive?.messageCount).toBe(6);
  return inactive?.leafEntryId ?? "a3";
}

describe("managed outgoing media retention across transcript branches", () => {
  beforeEach(async () => {
    stateDir = tempDirs.make("managed-media-branch-");
    mediaRoot = path.join(stateDir, "media");
    originalPath = path.join(mediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR, mediaId);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await seedSessionWithManagedImage();
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  it("retains media referenced only by an inactive branch after a rewind", async () => {
    await commitManagedRecord("a2");
    const restorableLeaf = await rewindPastManagedImage();

    const result = await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(listManagedImageRecordEntries({ stateDir })).toHaveLength(1);
    expect(await pathExists(originalPath)).toBe(true);

    const restored = await switchSessionBranch({
      agentId,
      env: process.env,
      leafEntryId: restorableLeaf,
      sessionKey,
    });
    expect(restored.status).toBe("created");
    const messages = await readActiveMessages();
    expect(messages).toHaveLength(6);
    expect(JSON.stringify(messages)).toContain(`${attachmentId}/full`);
    expect(await pathExists(originalPath)).toBe(true);
  });

  it("resolves an artifact download for media on an inactive branch", async () => {
    await commitManagedRecord("a2");
    await rewindPastManagedImage();

    await expect(
      resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        artifactId: `artifact_managed_image_${attachmentId}`,
        stateDir,
      }),
    ).resolves.not.toBeNull();
  });

  it("streams ticket-authenticated media referenced only by an inactive branch", async () => {
    await commitManagedRecord("a2");
    await rewindPastManagedImage();
    const download = await resolveManagedOutgoingMediaArtifactDownload({
      sessionKey,
      artifactId: `artifact_managed_image_${attachmentId}`,
      stateDir,
    });
    if (!download) {
      throw new Error("expected inactive-branch artifact download");
    }

    const response = await fetchManagedArtifact(download.url);

    expect(response).toEqual({
      body: Buffer.from("89504e470d0a1a0a", "hex"),
      status: 200,
    });
  });

  it("streams bearer-authenticated media referenced only by an inactive branch", async () => {
    await commitManagedRecord("a2");
    await rewindPastManagedImage();

    const response = await fetchManagedArtifact(mediaUrl(), {
      Authorization: "Bearer test-token",
    });

    expect(response).toEqual({
      body: Buffer.from("89504e470d0a1a0a", "hex"),
      status: 200,
    });
  });

  it("invalidates a warmed index after the production media rewrite rotates generation", async () => {
    await commitManagedRecord("a2");
    const source = await rewriteManagedMessageContent([
      { type: "text", text: "here is the chart\nMEDIA:/tmp/chart.png" },
    ]);
    expect(source.after.maxSeq).toBe(source.before.maxSeq);
    expect(source.after.generation).not.toBe(source.before.generation);
    await expect(
      resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        artifactId: `artifact_managed_image_${attachmentId}`,
        stateDir,
      }),
    ).resolves.toBeNull();

    const managedContent = [
      { type: "text", text: "here is the chart" },
      { type: "image", url: mediaUrl(), openUrl: mediaUrl(), mimeType: "image/png" },
    ];
    const rewritten = await rewriteAssistantTranscriptMessageByTurnIndexAndMedia({
      afterSeq: 0,
      assistantMessageIndex: 2,
      content: managedContent,
      expectedGeneration: source.after.generation,
      mediaUrls: ["/tmp/chart.png"],
      scope: currentTranscriptScope(),
    });
    expect(rewritten).toEqual({
      generation: expect.any(String),
      messageId: "a2",
    });
    if (!rewritten) {
      throw new Error("expected production transcript rewrite");
    }
    attachManagedOutgoingMediaToMessage({
      messageId: rewritten.messageId,
      blocks: managedContent,
      stateDir,
    });
    const restored = readSessionTranscriptWatermark(currentTranscriptScope());
    expect(restored.maxSeq).toBe(source.after.maxSeq);
    expect(restored.generation).toBe(rewritten.generation);
    expect(restored.generation).not.toBe(source.after.generation);

    await expect(
      resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        artifactId: `artifact_managed_image_${attachmentId}`,
        stateDir,
      }),
    ).resolves.not.toBeNull();
    await expect(
      cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId }),
    ).resolves.toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
  });

  it("keeps reset-hidden media until a later compaction restores it", async () => {
    await commitManagedRecord("a2");
    const scope = currentTranscriptScope();
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "a3",
      firstKeptEntryId: "u3",
      timestamp: "2026-08-01T00:01:00.000Z",
    });
    await appendTranscriptMessage(scope, {
      eventId: "post-reset",
      message: { role: "user", content: "new context" },
      now: Date.parse("2026-08-01T00:01:01.000Z"),
      parentId: "reset-boundary",
    });

    await expect(
      fetchManagedArtifact(mediaUrl(), {
        Authorization: "Bearer test-token",
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        artifactId: `artifact_managed_image_${attachmentId}`,
        stateDir,
      }),
    ).resolves.toBeNull();
    await expect(
      cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId }),
    ).resolves.toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await pathExists(originalPath)).toBe(true);

    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "newer-compaction",
      parentId: "post-reset",
      firstKeptEntryId: "post-reset",
      timestamp: "2026-08-01T00:01:02.000Z",
    });

    await expect(
      fetchManagedArtifact(mediaUrl(), {
        Authorization: "Bearer test-token",
      }),
    ).resolves.toEqual({
      body: Buffer.from("89504e470d0a1a0a", "hex"),
      status: 200,
    });
    await expect(
      resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        artifactId: `artifact_managed_image_${attachmentId}`,
        stateDir,
      }),
    ).resolves.not.toBeNull();
    await expect(
      cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId }),
    ).resolves.toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await pathExists(originalPath)).toBe(true);
  });

  it("keeps checkpoint-only media through cleanup and restore", async () => {
    await commitManagedRecord("a2");
    const currentSessionId = "post-compaction-current";
    const checkpointId = "managed-media-checkpoint";
    const currentScope = {
      agentId,
      env: process.env,
      sessionId: currentSessionId,
      sessionKey,
    };
    await replaceTranscriptEvents(currentScope, [
      { type: "session", id: currentSessionId, version: 3 },
      {
        type: "message",
        id: "post-compaction-message",
        parentId: null,
        message: { role: "user", content: "current compacted context" },
      },
    ]);
    await upsertSessionEntryCore(currentScope, {
      sessionId: currentSessionId,
      updatedAt: Date.now(),
      compactionCheckpoints: [
        {
          checkpointId,
          sessionKey,
          sessionId: currentSessionId,
          createdAt: Date.now(),
          reason: "manual",
          preCompaction: {
            sessionId,
            leafId: "a3",
          },
          postCompaction: {
            sessionId: currentSessionId,
            entryId: "post-compaction-message",
          },
        },
      ],
    });

    await expect(
      fetchManagedArtifact(mediaUrl(), {
        Authorization: "Bearer test-token",
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId }),
    ).resolves.toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await pathExists(originalPath)).toBe(true);

    const restored = await restoreCompactionCheckpointSession({
      agentId,
      env: process.env,
      expectedState: { sessionId: currentSessionId, lifecycleRevision: undefined },
      sessionKey,
      checkpointId,
    });
    expect(restored.status).toBe("created");
    await expect(
      fetchManagedArtifact(mediaUrl(), {
        Authorization: "Bearer test-token",
      }),
    ).resolves.toEqual({
      body: Buffer.from("89504e470d0a1a0a", "hex"),
      status: 200,
    });
    await expect(
      resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        artifactId: `artifact_managed_image_${attachmentId}`,
        stateDir,
      }),
    ).resolves.not.toBeNull();
  });

  it("moves the retention fence when a checkpoint is published after a retention read", async () => {
    await commitManagedRecord("missing-message");
    const scope = currentTranscriptScope();

    const beforePublication = readSessionTranscriptRetentionFence(scope);
    expect(readSessionTranscriptRetentionFence(scope)).toBe(beforePublication);

    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
      compactionCheckpoints: [
        {
          checkpointId: "late-checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: Date.now(),
          reason: "manual",
          preCompaction: { sessionId, leafId: "a3" },
          postCompaction: { sessionId: scope.sessionId, entryId: "a2" },
        },
      ],
    });

    expect(readSessionTranscriptRetentionFence(scope)).not.toBe(beforePublication);
  });

  it("keeps media whose message a checkpoint publication restores before deletion", async () => {
    await commitManagedRecord("a2");
    const scope = currentTranscriptScope();
    const currentSessionId = "fenced-post-compaction";
    const currentScope = { agentId, env: process.env, sessionId: currentSessionId, sessionKey };
    await replaceTranscriptEvents(currentScope, [
      { type: "session", id: currentSessionId, version: 3 },
      {
        type: "message",
        id: "fenced-current-message",
        parentId: null,
        message: { role: "user", content: "current compacted context" },
      },
    ]);
    await upsertSessionEntryCore(currentScope, {
      sessionId: currentSessionId,
      updatedAt: Date.now(),
    });

    const unfenced = readSessionTranscriptRetentionFence(currentScope);

    await upsertSessionEntryCore(currentScope, {
      sessionId: currentSessionId,
      updatedAt: Date.now(),
      compactionCheckpoints: [
        {
          checkpointId: "fenced-checkpoint",
          sessionKey,
          sessionId: currentSessionId,
          createdAt: Date.now(),
          reason: "manual",
          preCompaction: { sessionId, leafId: "a3" },
          postCompaction: { sessionId: currentSessionId, entryId: "fenced-current-message" },
        },
      ],
    });

    expect(readSessionTranscriptRetentionFence(currentScope)).not.toBe(unfenced);
    expect(readSessionTranscriptRetentionFence(scope)).not.toBe(unfenced);

    await expect(
      cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId }),
    ).resolves.toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await pathExists(originalPath)).toBe(true);
  });

  it("still deletes media whose message is absent from every branch", async () => {
    await commitManagedRecord("missing-message");

    const result = await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId });

    expect(result).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
    expect(listManagedImageRecordEntries({ stateDir })).toHaveLength(0);
    expect(await pathExists(originalPath)).toBe(false);
  });
});
