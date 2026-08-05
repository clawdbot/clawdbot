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

import {
  cleanupManagedOutgoingMediaRecords,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
} from "./managed-image-record-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createManagedMediaFixture(
  stateDir: string,
  attachmentId: string,
  sessionKey = "agent:main:main",
) {
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

async function createDuplicateCanonicalKeyStore(stateDir: string): Promise<void> {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  writeSessionEntry(database, "agent:main:work", {
    sessionId: "sess-work",
    updatedAt: Date.now(),
  });
  // Raw insert of the legacy ":main" alias row. Canonical write assertions
  // refuse this key under mainKey "work"; this is the pre-repair state that
  // openclaw doctor --fix owns, so it must keep surfacing as a migration
  // error instead of an unavailable store.
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      "agent:main:main",
      "sess-legacy-main",
      JSON.stringify({ sessionId: "sess-legacy-main", updatedAt: 1 }),
      1,
    );
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("sess-legacy-main", "agent:main:main", 1, 1);
  // The insert trigger marks new rows pending (entry_valid = 0); settle this
  // row the way ensureSessionEntryValidityProjection would after open.
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run("agent:main:main");
  closeOpenClawAgentDatabasesForTest();
}

describe("managed media with a session store pending canonical-key repair", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tempDirs.make("managed-image-canonical-migration-");
    vi.clearAllMocks();
    getRuntimeConfigMock.mockReturnValue({
      agents: { list: [{ id: "main" }] },
      session: { mainKey: "work" },
    });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("surfaces canonical migration errors on the artifact read path instead of a 404", async () => {
    await withEnvAsync({ ...process.env, OPENCLAW_STATE_DIR: stateDir }, async () => {
      const attachmentId = "33333333-3333-4333-8333-333333333333";
      await createManagedMediaFixture(stateDir, attachmentId, "agent:main:work");
      await createDuplicateCanonicalKeyStore(stateDir);

      await expect(
        resolveManagedOutgoingMediaArtifactDownload({
          sessionKey: "agent:main:work",
          artifactId: `artifact_managed_image_${attachmentId}`,
          stateDir,
        }),
      ).rejects.toThrow(/openclaw doctor --fix/);
    });
  });

  it("retains managed media when the session store needs canonical-key repair", async () => {
    await withEnvAsync({ ...process.env, OPENCLAW_STATE_DIR: stateDir }, async () => {
      const fixture = await createManagedMediaFixture(
        stateDir,
        "44444444-4444-4444-8444-444444444444",
        "agent:main:work",
      );
      await createDuplicateCanonicalKeyStore(stateDir);

      const result = await cleanupManagedOutgoingMediaRecords({ stateDir });

      expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
      await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    });
  });
});
