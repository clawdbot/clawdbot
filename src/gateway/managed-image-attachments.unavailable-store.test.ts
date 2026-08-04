// Regression coverage for #119090: managed-media cleanup must fail closed when
// the owning SQLite session store is unreadable. These tests drive the real
// session-store lookup (no session-utils mock) against a real agent database,
// so an unreadable store surfaces as a thrown read that cleanup must treat as
// unknown retention state instead of proof the record is unreferenced.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";

const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../config/io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.js")>();
  return { ...actual, getRuntimeConfig: getRuntimeConfigMock };
});
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));
vi.mock("./session-transcript-readers.js", () => ({
  readSessionMessagesWithSourceAsync: vi.fn(async () => ({ messages: [], transcriptPath: null })),
}));
vi.mock("../media/media-probe.js", () => ({
  probePlaybackMediaFileDescriptor: vi.fn(async () => ({ durationMs: 1000 })),
}));
vi.mock("../media/playback-transcode.js", () => ({
  replacePlaybackFileExtension: vi.fn((value: string) => value),
  resolvePlaybackModeForSource: vi.fn(async () => "native"),
  resolvePlaybackTranscode: vi.fn(async () => ({ kind: "passthrough" })),
}));
vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: vi.fn(),
  resolveOpenAiCompatibleHttpOperatorScopes: vi.fn(),
  resolveOpenAiCompatibleHttpSenderIsOwner: vi.fn(),
}));

import { cleanupManagedOutgoingMediaRecords } from "./managed-image-attachments.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
} from "./managed-image-record-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createManagedMediaFixture(stateDir: string, attachmentId: string) {
  const sessionKey = "agent:main:main";
  const filename = `${attachmentId}-cat-full.png`;
  const originalPath = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR, filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.writeFile(originalPath, "original-image");
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      messageId: "msg-1",
      createdAt: new Date().toISOString(),
      alt: "Cat",
      original: {
        mediaRoot: path.join(stateDir, "media"),
        mediaId: filename,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: "image/png",
        width: 1024,
        height: 768,
        sizeBytes: 14,
        filename: "cat.png",
      },
    },
    stateDir,
  );
  return { sessionKey, originalPath };
}

async function createRealSessionStore(stateDir: string): Promise<string> {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  writeSessionEntry(database, "agent:main:main", {
    sessionId: "sess-main",
    updatedAt: Date.now(),
  });
  closeOpenClawAgentDatabasesForTest();
  return path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
}

describe("cleanupManagedOutgoingMediaRecords with a real SQLite session store", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tempDirs.make("managed-image-unavailable-store-");
    vi.clearAllMocks();
    getRuntimeConfigMock.mockReturnValue({ agents: { list: [{ id: "main" }] } });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs
      .chmod(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"), 0o644)
      .catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("deletes an unreferenced record when the session store is healthy", async () => {
    await withEnvAsync({ ...process.env, OPENCLAW_STATE_DIR: stateDir }, async () => {
      const fixture = await createManagedMediaFixture(
        stateDir,
        "11111111-1111-4111-8111-111111111111",
      );
      await createRealSessionStore(stateDir);

      const result = await cleanupManagedOutgoingMediaRecords({ stateDir });

      expect(result).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
      await expect(fs.access(fixture.originalPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("retains a record when the session store is unreadable", async () => {
    await withEnvAsync({ ...process.env, OPENCLAW_STATE_DIR: stateDir }, async () => {
      const fixture = await createManagedMediaFixture(
        stateDir,
        "22222222-2222-4222-8222-222222222222",
      );
      const agentSqlitePath = await createRealSessionStore(stateDir);
      await fs.chmod(agentSqlitePath, 0o000);

      const result = await cleanupManagedOutgoingMediaRecords({ stateDir });

      expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
      await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    });
  });
});
