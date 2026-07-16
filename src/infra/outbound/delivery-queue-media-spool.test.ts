import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeSpy = vi.hoisted(() => ({
  onMove: null as ((from: string, to: string, rootDir: string) => void) | null,
}));

vi.mock("../file-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../file-store.js")>();
  return {
    ...actual,
    fileStore: (options: Parameters<typeof actual.fileStore>[0]) => {
      const store = actual.fileStore(options);
      return {
        ...store,
        root: async () => {
          const root = await store.root();
          return {
            ...root,
            move: async (from: string, to: string, moveOptions?: unknown) => {
              storeSpy.onMove?.(from, to, options.rootDir);
              return await (root.move as (...args: unknown[]) => Promise<void>)(
                from,
                to,
                moveOptions,
              );
            },
          };
        },
      };
    },
  };
});

const {
  collectEntrySpoolPaths,
  pruneOrphanedDeliveryQueueMedia,
  releaseSpoolArtifacts,
  stageQueuePayloadMedia,
} = await import("./delivery-queue-media-spool.js");
const { enqueueDelivery, loadPendingDeliveries } = await import("./delivery-queue-storage.js");

const DAY_MS = 24 * 60 * 60_000;
const ARTIFACT_A = "00000000-0000-4000-8000-000000000001.ogg";
const ARTIFACT_B = "00000000-0000-4000-8000-000000000002.ogg";
const PART_ARTIFACT = "00000000-0000-4000-8000-000000000003.ogg.part";

let stateDir: string;
let sourceDir: string;
let spoolRoot: string;

const exists = (target: string) =>
  fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

async function seedArtifact(name: string, ageMs: number): Promise<string> {
  await fs.mkdir(spoolRoot, { recursive: true });
  const artifactPath = path.join(spoolRoot, name);
  await fs.writeFile(artifactPath, "audio-bytes");
  const timestamp = new Date(Date.now() - ageMs);
  await fs.utimes(artifactPath, timestamp, timestamp);
  return artifactPath;
}

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spool-state-")));
  sourceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spool-src-")));
  spoolRoot = path.join(stateDir, "delivery-queue-media");
  storeSpy.onMove = null;
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

describe("retention", () => {
  it("keeps pending media regardless of age and removes only old unreferenced artifacts", async () => {
    const retained = await seedArtifact(ARTIFACT_A, 30 * DAY_MS);
    const orphan = await seedArtifact(ARTIFACT_B, 30 * DAY_MS);
    const fresh = await seedArtifact(PART_ARTIFACT, DAY_MS / 2);
    await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ mediaUrl: retained }],
      },
      stateDir,
    );

    await pruneOrphanedDeliveryQueueMedia({ stateDir });

    expect(await exists(retained)).toBe(true);
    expect(await exists(orphan)).toBe(false);
    // Grace protects stage-before-row-commit and bounds crash leftovers.
    expect(await exists(fresh)).toBe(true);
  });

  it("reclaims stale partial writes but ignores foreign files and symlinks", async () => {
    const partial = await seedArtifact(PART_ARTIFACT, 2 * DAY_MS);
    const foreign = await seedArtifact("operator-note.txt", 2 * DAY_MS);
    const outside = path.join(sourceDir, "precious.txt");
    await fs.writeFile(outside, "keep");
    await fs.symlink(outside, path.join(spoolRoot, ARTIFACT_A));

    await pruneOrphanedDeliveryQueueMedia({ stateDir });

    expect(await exists(partial)).toBe(false);
    expect(await exists(foreign)).toBe(true);
    expect(await fs.readFile(outside, "utf8")).toBe("keep");
  });

  it("expires abandoned stages and rejects a producer that resumes too late", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");
    const staged = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: source, audioAsVoice: true }],
      mediaAccess: { localRoots: [sourceDir] },
      maxBytes: 1024 * 1024,
      stateDir,
    });
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") {
      return;
    }

    // Simulate a producer suspended beyond the one-day staging lease. GC wins
    // the SQLite transaction, so the resumed producer cannot publish a broken row.
    await pruneOrphanedDeliveryQueueMedia({
      stateDir,
      nowMs: Date.now() + 2 * DAY_MS,
    });

    await expect(fs.stat(staged.artifacts[0] as string)).rejects.toThrow();
    await expect(
      enqueueDelivery(
        {
          channel: "matrix",
          to: "!room:example",
          payloads: staged.payloads,
        },
        stateDir,
        staged.mediaStageId,
      ),
    ).rejects.toThrow("media stage expired before enqueue");
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
  });
});

describe("ownership helpers", () => {
  it("collects only spool-owned references", () => {
    const spoolPath = path.join(spoolRoot, ARTIFACT_A);
    expect(
      collectEntrySpoolPaths(
        [
          { mediaUrl: spoolPath },
          { mediaUrl: "https://example.com/a.ogg" },
          { mediaUrl: path.join(sourceDir, "b.ogg") },
        ],
        stateDir,
      ),
    ).toEqual([spoolPath]);
  });

  it("refuses to release paths outside the spool", async () => {
    const outside = path.join(sourceDir, "not-ours.ogg");
    await fs.writeFile(outside, "bytes");

    await releaseSpoolArtifacts([outside, path.join(spoolRoot, "..", "escape.ogg")], stateDir);

    expect(await exists(outside)).toBe(true);
  });
});

describe("staging", () => {
  const mediaAccessFor = (roots: string[]) => ({ localRoots: roots });

  it("copies a local source for the queue and survives producer cleanup", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");
    const livePayload = { text: "hi", mediaUrl: source };

    const result = await stageQueuePayloadMedia({
      payloads: [livePayload],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });
    await fs.rm(source);

    expect(result.status).toBe("staged");
    if (result.status !== "staged") {
      return;
    }
    const staged = result.payloads[0]?.mediaUrl as string;
    expect(path.dirname(staged)).toBe(spoolRoot);
    expect(await fs.readFile(staged, "utf8")).toBe("opus-bytes");
    expect(livePayload.mediaUrl).toBe(source);
    expect(result.artifacts).toEqual([staged]);
  });

  it("leaves replayable remote media untouched without creating the spool", async () => {
    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: "https://example.com/a.ogg" }],
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result).toEqual({
      status: "staged",
      payloads: [{ mediaUrl: "https://example.com/a.ogg" }],
      artifacts: [],
    });
    expect(await exists(spoolRoot)).toBe(false);
  });

  it("does not make sensitive media durable", async () => {
    const source = path.join(sourceDir, "secret.ogg");
    await fs.writeFile(source, "private");

    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: source, sensitiveMedia: true }],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result).toEqual({ status: "not-durable", reason: "sensitive-media" });
    expect(await exists(spoolRoot)).toBe(false);
  });

  it("uses the live send's local-read capability", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");

    await expect(
      stageQueuePayloadMedia({
        payloads: [{ mediaUrl: source }],
        mediaAccess: mediaAccessFor([path.join(stateDir, "elsewhere")]),
        maxBytes: 1024 * 1024,
        stateDir,
      }),
    ).rejects.toThrow();
  });

  it("publishes the final path only after the copy is complete", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");
    const atMove: { finalExisted: boolean; partSize: number }[] = [];
    storeSpy.onMove = (from, to, rootDir) => {
      atMove.push({
        finalExisted: existsSync(path.join(rootDir, to)),
        partSize: statSync(path.join(rootDir, from)).size,
      });
    };

    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: source }],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result.status).toBe("staged");
    expect(atMove).toEqual([{ finalExisted: false, partSize: "opus-bytes".length }]);
    expect(await fs.readdir(spoolRoot)).toHaveLength(1);
  });

  it("cleans earlier copies when a later source fails", async () => {
    const good = path.join(sourceDir, "first.ogg");
    await fs.writeFile(good, "opus-bytes");

    await expect(
      stageQueuePayloadMedia({
        payloads: [{ mediaUrls: [good, path.join(sourceDir, "missing.ogg")] }],
        mediaAccess: mediaAccessFor([sourceDir]),
        maxBytes: 1024 * 1024,
        stateDir,
      }),
    ).rejects.toThrow();

    expect(await fs.readdir(spoolRoot).catch(() => [])).toEqual([]);
  });

  it("copies a repeated source once", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");

    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: source }, { mediaUrl: source }],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result.status).toBe("staged");
    if (result.status !== "staged") {
      return;
    }
    expect(result.artifacts).toHaveLength(1);
    expect(result.payloads[0]?.mediaUrl).toBe(result.payloads[1]?.mediaUrl);
  });

  it("preserves blank media slots while staging valid local media", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");

    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: " ", mediaUrls: ["", source, "  "] }],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result.status).toBe("staged");
    if (result.status !== "staged") {
      return;
    }
    expect(result.artifacts).toHaveLength(1);
    expect(result.payloads[0]).toEqual({
      mediaUrl: " ",
      mediaUrls: ["", result.artifacts[0], "  "],
    });
  });
});
