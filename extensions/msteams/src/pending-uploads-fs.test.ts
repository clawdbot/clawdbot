import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFileConsentActivityFs } from "./file-consent-helpers.js";
import {
  getPendingUploadFs,
  removePendingUploadFs,
  setPendingUploadActivityIdFs,
  storePendingUploadFs,
} from "./pending-uploads-fs.js";
import { clearPendingUploads } from "./pending-uploads.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

// Track temp dirs created by each test so afterEach can clean them up.
const createdTempDirs: string[] = [];

async function makeTempStateDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-pending-"));
  createdTempDirs.push(dir);
  return dir;
}

function makeEnv(stateDir: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

async function requirePendingUpload(id: string, env: NodeJS.ProcessEnv) {
  const upload = await getPendingUploadFs(id, { env });
  if (!upload) {
    throw new Error(`expected pending upload ${id}`);
  }
  return upload;
}

async function cleanupTempDirs(): Promise<void> {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    if (!dir) {
      continue;
    }
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // tmp dir may already be gone
    }
  }
}

describe("msteams pending uploads (fs-backed)", () => {
  beforeEach(() => {
    setMSTeamsRuntime(msteamsRuntimeStub);
    clearPendingUploads();
  });

  afterEach(async () => {
    await cleanupTempDirs();
    vi.useRealTimers();
  });

  it("stores and retrieves a pending upload by id", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    await storePendingUploadFs(
      {
        id: "upload-1",
        buffer: Buffer.from("hello world"),
        filename: "greeting.txt",
        contentType: "text/plain",
        conversationId: "19:conv@thread.v2",
      },
      { env },
    );

    const loaded = await requirePendingUpload("upload-1", env);
    expect(loaded.id).toBe("upload-1");
    expect(loaded.filename).toBe("greeting.txt");
    expect(loaded.contentType).toBe("text/plain");
    expect(loaded.conversationId).toBe("19:conv@thread.v2");
    expect(loaded.buffer.toString("utf8")).toBe("hello world");
  });

  it("returns undefined for missing and undefined ids", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    expect(await getPendingUploadFs(undefined, { env })).toBeUndefined();
    expect(await getPendingUploadFs("does-not-exist", { env })).toBeUndefined();
  });

  it("persists so another reader finds the entry (simulates cross-process)", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    // First "process": writer
    await storePendingUploadFs(
      {
        id: "upload-x",
        buffer: Buffer.from("top secret"),
        filename: "secret.bin",
        conversationId: "19:conv@thread.v2",
      },
      { env },
    );

    // Confirm the backing file actually exists on disk with expected shape
    const storePath = path.join(stateDir, "msteams-pending-uploads.json");
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      version: number;
      uploads: Record<string, { bufferBase64: string; filename: string }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.uploads["upload-x"]?.filename).toBe("secret.bin");
    expect(Buffer.from(parsed.uploads["upload-x"].bufferBase64, "base64").toString("utf8")).toBe(
      "top secret",
    );

    // Second "process": reader using the same state dir
    const reader = await getPendingUploadFs("upload-x", { env });
    expect(reader?.buffer.toString("utf8")).toBe("top secret");
    expect(reader?.filename).toBe("secret.bin");
  });

  it("removes persisted entries", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    await storePendingUploadFs(
      {
        id: "upload-rm",
        buffer: Buffer.from("x"),
        filename: "rm.bin",
        conversationId: "19:conv@thread.v2",
      },
      { env },
    );
    const loaded = await requirePendingUpload("upload-rm", env);
    expect(loaded.id).toBe("upload-rm");
    expect(loaded.filename).toBe("rm.bin");
    expect(loaded.contentType).toBeUndefined();
    expect(loaded.conversationId).toBe("19:conv@thread.v2");
    expect(loaded.consentCardActivityId).toBeUndefined();
    expect(loaded.buffer.toString("utf8")).toBe("x");
    expect(Number.isFinite(loaded.createdAt)).toBe(true);

    await removePendingUploadFs("upload-rm", { env });
    expect(await getPendingUploadFs("upload-rm", { env })).toBeUndefined();
  });

  it("remove is a no-op for unknown ids", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    await expect(removePendingUploadFs("never-existed", { env })).resolves.toBeUndefined();
    await expect(removePendingUploadFs(undefined, { env })).resolves.toBeUndefined();
  });

  it("expires entries past their ttl on read", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);
    const now = new Date("2026-05-08T00:00:00.000Z");
    vi.useFakeTimers({ now });

    await storePendingUploadFs(
      {
        id: "upload-old",
        buffer: Buffer.from("stale"),
        filename: "stale.txt",
        conversationId: "19:conv@thread.v2",
      },
      { env, ttlMs: 1 },
    );
    vi.setSystemTime(now.getTime() + 2);
    expect(await getPendingUploadFs("upload-old", { env, ttlMs: 1 })).toBeUndefined();
  });

  it("updates consent card activity id on an existing entry", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    await storePendingUploadFs(
      {
        id: "upload-a",
        buffer: Buffer.from("payload"),
        filename: "f.txt",
        conversationId: "19:conv@thread.v2",
      },
      { env },
    );

    await setPendingUploadActivityIdFs("upload-a", "activity-xyz", { env });
    const loaded = await getPendingUploadFs("upload-a", { env });
    expect(loaded?.consentCardActivityId).toBe("activity-xyz");
  });

  it("ignores malformed or empty store files and returns undefined", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);
    const storePath = path.join(stateDir, "msteams-pending-uploads.json");
    await fs.promises.writeFile(storePath, "not valid json", "utf-8");

    // Should not throw and should treat as empty
    expect(await getPendingUploadFs("anything", { env })).toBeUndefined();

    await fs.promises.writeFile(storePath, JSON.stringify({ version: 2, uploads: {} }), "utf-8");
    expect(await getPendingUploadFs("anything", { env })).toBeUndefined();
  });
});

describe("prepareFileConsentActivityFs end-to-end", () => {
  beforeEach(() => {
    setMSTeamsRuntime(msteamsRuntimeStub);
    clearPendingUploads();
  });

  afterEach(async () => {
    await cleanupTempDirs();
  });

  it("writes the pending upload to the fs store with the same id as the card", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);
    // Redirect state dir via env so the helper's FS writes land under our tmp
    const originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const result = await prepareFileConsentActivityFs({
        media: {
          buffer: Buffer.from("cli file"),
          filename: "cli.bin",
          contentType: "application/octet-stream",
        },
        conversationId: "19:victim@thread.v2",
        description: "Sent via CLI",
      });

      expect(result.uploadId).toMatch(/[0-9a-f-]/);
      const attachments = result.activity.attachments as Array<Record<string, unknown>>;
      expect(attachments).toHaveLength(1);
      const content = attachments[0]?.content as { acceptContext: { uploadId: string } };
      expect(content.acceptContext.uploadId).toBe(result.uploadId);

      // Reader in (simulated) other process finds the entry under the same key
      const loaded = await requirePendingUpload(result.uploadId, env);
      expect(loaded.filename).toBe("cli.bin");
      expect(loaded.contentType).toBe("application/octet-stream");
      expect(loaded.conversationId).toBe("19:victim@thread.v2");
      expect(loaded.buffer.toString("utf8")).toBe("cli file");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalEnv;
      }
    }
  });
});
