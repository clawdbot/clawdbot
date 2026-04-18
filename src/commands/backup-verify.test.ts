import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBackupArchiveRoot } from "./backup-shared.js";
import { backupVerifyCommand } from "./backup-verify.js";

const TEST_ARCHIVE_ROOT = "2026-03-09T00-00-00.000Z-openclaw-backup";

const createBackupVerifyRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

function createBackupManifest(assetArchivePath: string, archiveRoot = TEST_ARCHIVE_ROOT) {
  return {
    schemaVersion: 1,
    createdAt: "2026-03-09T00:00:00.000Z",
    archiveRoot,
    runtimeVersion: "test",
    platform: process.platform,
    nodeVersion: process.version,
    assets: [
      {
        kind: "state",
        sourcePath: "/tmp/.openclaw",
        archivePath: assetArchivePath,
      },
    ],
  };
}

async function withBrokenArchiveFixture(
  options: {
    tempPrefix: string;
    manifestAssetArchivePath: string;
    payloads: Array<{ fileName: string; contents: string; archivePath?: string }>;
    buildTarEntries?: (paths: { manifestPath: string; payloadPaths: string[] }) => string[];
  },
  run: (archivePath: string) => Promise<void>,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
  const archivePath = path.join(tempDir, "broken.tar.gz");
  const manifestPath = path.join(tempDir, "manifest.json");
  const payloadSpecs = await Promise.all(
    options.payloads.map(async (payload) => {
      const payloadPath = path.join(tempDir, payload.fileName);
      await fs.writeFile(payloadPath, payload.contents, "utf8");
      return {
        path: payloadPath,
        archivePath: payload.archivePath ?? options.manifestAssetArchivePath,
      };
    }),
  );
  const payloadEntryPathBySource = new Map(
    payloadSpecs.map((payload) => [payload.path, payload.archivePath]),
  );

  try {
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(createBackupManifest(options.manifestAssetArchivePath), null, 2)}\n`,
      "utf8",
    );
    await tar.c(
      {
        file: archivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          if (entry.path === manifestPath) {
            entry.path = `${TEST_ARCHIVE_ROOT}/manifest.json`;
            return;
          }
          const payloadEntryPath = payloadEntryPathBySource.get(entry.path);
          if (payloadEntryPath) {
            entry.path = payloadEntryPath;
          }
        },
      },
      options.buildTarEntries?.({
        manifestPath,
        payloadPaths: payloadSpecs.map((payload) => payload.path),
      }) ?? [manifestPath, ...payloadSpecs.map((payload) => payload.path)],
    );
    await run(archivePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("backupVerifyCommand", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("verifies a valid backup archive", async () => {
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-out-"));
    try {
      const runtime = createBackupVerifyRuntime();
      const nowMs = Date.UTC(2026, 2, 9, 0, 0, 0);
      const archiveRoot = buildBackupArchiveRoot(nowMs);
      const archivePath = path.join(archiveDir, "backup.tar.gz");
      const manifestPath = path.join(archiveDir, "manifest.json");
      const payloadPath = path.join(archiveDir, "state.txt");
      const payloadArchivePath = `${archiveRoot}/payload/posix/tmp/.openclaw/state.txt`;
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify(createBackupManifest(payloadArchivePath, archiveRoot), null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(payloadPath, "hello\n", "utf8");
      await tar.c(
        {
          file: archivePath,
          gzip: true,
          portable: true,
          preservePaths: true,
          onWriteEntry: (entry) => {
            if (entry.path === manifestPath) {
              entry.path = `${archiveRoot}/manifest.json`;
              return;
            }
            if (entry.path === payloadPath) {
              entry.path = payloadArchivePath;
            }
          },
        },
        [manifestPath, payloadPath],
      );
      const verified = await backupVerifyCommand(runtime, { archive: archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.archiveRoot).toBe(archiveRoot);
      expect(verified.assetCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("fails when the archive does not contain a manifest", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-no-manifest-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const root = path.join(tempDir, "root");
      await fs.mkdir(path.join(root, "payload"), { recursive: true });
      await fs.writeFile(path.join(root, "payload", "data.txt"), "x\n", "utf8");
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, ["root"]);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /expected exactly one backup manifest entry/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when the manifest references a missing asset payload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-missing-asset-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const root = path.join(tempDir, rootName);
      await fs.mkdir(root, { recursive: true });
      const manifest = {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot: rootName,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: "/tmp/.openclaw",
            archivePath: `${rootName}/payload/posix/tmp/.openclaw`,
          },
        ],
      };
      await fs.writeFile(
        path.join(root, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, [rootName]);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /missing payload for manifest asset/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe archive paths", async () => {
    for (const { tempPrefix, archivePath, error } of [
      {
        tempPrefix: "openclaw-backup-traversal-",
        archivePath: `${TEST_ARCHIVE_ROOT}/payload/../escaped.txt`,
        error: /path traversal segments/i,
      },
      {
        tempPrefix: "openclaw-backup-backslash-",
        archivePath: `${TEST_ARCHIVE_ROOT}/payload\\..\\escaped.txt`,
        error: /forward slashes/i,
      },
    ]) {
      await withBrokenArchiveFixture(
        {
          tempPrefix,
          manifestAssetArchivePath: archivePath,
          payloads: [{ fileName: "payload.txt", contents: "payload\n", archivePath }],
        },
        async (brokenArchivePath) => {
          const runtime = createBackupVerifyRuntime();
          await expect(
            backupVerifyCommand(runtime, { archive: brokenArchivePath }),
          ).rejects.toThrow(error);
        },
      );
    }
  });

  it("ignores payload manifest.json files when locating the backup manifest", async () => {
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-out-"));
    try {
      const runtime = createBackupVerifyRuntime();
      const nowMs = Date.UTC(2026, 2, 9, 2, 0, 0);
      const archiveRoot = buildBackupArchiveRoot(nowMs);
      const archivePath = path.join(archiveDir, "backup.tar.gz");
      const manifestPath = path.join(archiveDir, "manifest.json");
      const statePayloadPath = path.join(archiveDir, "state.txt");
      const workspaceManifestPayloadPath = path.join(archiveDir, "workspace-manifest.json");
      const stateArchivePath = `${archiveRoot}/payload/posix/tmp/.openclaw/state.txt`;
      const workspaceArchivePath = `${archiveRoot}/payload/posix/tmp/workspace/manifest.json`;
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...createBackupManifest(stateArchivePath, archiveRoot),
            assets: [
              {
                kind: "state",
                sourcePath: "/tmp/.openclaw",
                archivePath: stateArchivePath,
              },
              {
                kind: "workspace",
                sourcePath: "/tmp/workspace",
                archivePath: workspaceArchivePath,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(statePayloadPath, "hello\n", "utf8");
      await fs.writeFile(
        workspaceManifestPayloadPath,
        JSON.stringify({ name: "workspace-payload" }),
        "utf8",
      );
      await tar.c(
        {
          file: archivePath,
          gzip: true,
          portable: true,
          preservePaths: true,
          onWriteEntry: (entry) => {
            if (entry.path === manifestPath) {
              entry.path = `${archiveRoot}/manifest.json`;
              return;
            }
            if (entry.path === statePayloadPath) {
              entry.path = stateArchivePath;
              return;
            }
            if (entry.path === workspaceManifestPayloadPath) {
              entry.path = workspaceArchivePath;
            }
          },
        },
        [manifestPath, statePayloadPath, workspaceManifestPayloadPath],
      );
      const verified = await backupVerifyCommand(runtime, { archive: archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.assetCount).toBeGreaterThanOrEqual(2);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate manifest and payload entries", async () => {
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
    for (const options of [
      {
        tempPrefix: "openclaw-backup-duplicate-manifest-",
        payloads: [{ fileName: "payload.txt", contents: "payload\n" }],
        buildTarEntries: ({
          manifestPath,
          payloadPaths,
        }: {
          manifestPath: string;
          payloadPaths: string[];
        }) => [manifestPath, manifestPath, ...payloadPaths],
        error: /expected exactly one backup manifest entry, found 2/i,
      },
      {
        tempPrefix: "openclaw-backup-duplicate-payload-",
        payloads: [
          { fileName: "payload-a.txt", contents: "payload-a\n", archivePath: payloadArchivePath },
          { fileName: "payload-b.txt", contents: "payload-b\n", archivePath: payloadArchivePath },
        ],
        error: /duplicate entry path/i,
      },
    ]) {
      await withBrokenArchiveFixture(
        {
          tempPrefix: options.tempPrefix,
          manifestAssetArchivePath: payloadArchivePath,
          payloads: options.payloads,
          buildTarEntries: options.buildTarEntries,
        },
        async (archivePath) => {
          const runtime = createBackupVerifyRuntime();
          await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
            options.error,
          );
        },
      );
    }
  });
});
