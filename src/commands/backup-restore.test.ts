// Backup restore tests cover verified whole-archive extraction and fresh-target safety.
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { createBackupArchive } from "../infra/backup-create.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { buildBackupArchivePath } from "./backup-shared.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

async function listArchiveLeafEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onReadEntry: (entry) => {
      if (entry.type !== "Directory") {
        entries.push(entry.path.replace(/\/+$/u, ""));
      }
    },
  });
  return entries.toSorted();
}

async function listFilesystemLeafEntries(root: string, relative = ""): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await listFilesystemLeafEntries(root, child)));
    } else {
      entries.push(child.split(path.sep).join("/"));
    }
  }
  return entries.toSorted();
}

function encodeTarEntry(params: {
  path: string;
  contents?: string;
  type?: "File" | "Directory" | "Link";
  linkpath?: string;
}): Buffer {
  const body = Buffer.from(params.contents ?? "", "utf8");
  const type = params.type ?? "File";
  const header = new tar.Header({
    path: params.path,
    type,
    size: type === "File" ? body.length : 0,
    mode: type === "Directory" ? 0o700 : 0o600,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
    ...(params.linkpath ? { linkpath: params.linkpath } : {}),
  });
  const headerBlock = Buffer.alloc(512);
  header.encode(headerBlock);
  if (type !== "File") {
    return headerBlock;
  }
  return Buffer.concat([headerBlock, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

async function writeArchive(params: {
  archivePath: string;
  archiveRoot: string;
  payloadPath: string;
  manifest?: string;
  extraEntries?: Buffer[];
}): Promise<void> {
  const manifest =
    params.manifest ??
    `${JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      archiveRoot: params.archiveRoot,
      runtimeVersion: "test",
      platform: process.platform,
      nodeVersion: process.version,
      assets: [
        {
          kind: "config",
          sourcePath: "/tmp/openclaw.json",
          archivePath: params.payloadPath,
        },
      ],
    })}\n`;
  await fs.writeFile(
    params.archivePath,
    gzipSync(
      Buffer.concat([
        encodeTarEntry({ path: `${params.archiveRoot}/manifest.json`, contents: manifest }),
        encodeTarEntry({ path: params.payloadPath, contents: "{}\n" }),
        ...(params.extraEntries ?? []),
        Buffer.alloc(1024),
      ]),
    ),
  );
}

describe("backupRestoreCommand", () => {
  it("round-trips a backup into a fresh target with matching inventory and readable databases", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restore-roundtrip-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const targetPath = state.path("restored");
        await fs.mkdir(outputDir, { recursive: true });
        await state.writeText("operator-note.txt", "restore me\n");
        openOpenClawStateDatabase({ env: state.env });

        try {
          const backup = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 7, 12, 12, 0, 0),
          });
          const runtime = createRuntime();
          const restored = await backupRestoreCommand(runtime, {
            archive: backup.archivePath,
            target: targetPath,
            json: true,
          });

          expect(restored).toMatchObject({
            ok: true,
            archivePath: backup.archivePath,
            targetPath,
            archiveRoot: backup.archiveRoot,
            assetCount: 1,
          });
          expect(restored.warnings.join("\n")).toMatch(/time travel/iu);
          expect(restored.warnings.join("\n")).toMatch(/WhatsApp/iu);
          expect(restored.warnings.join("\n")).toMatch(/pending approvals/iu);
          expect(restored.warnings.join("\n")).toMatch(/plugins install <spec> --force/iu);
          expect(runtime.log).toHaveBeenCalledOnce();
          expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual(restored);

          expect(await listFilesystemLeafEntries(targetPath)).toEqual(
            await listArchiveLeafEntries(backup.archivePath),
          );
          const databaseEntry = (await listArchiveLeafEntries(backup.archivePath)).find((entry) =>
            entry.endsWith("/state/openclaw.sqlite"),
          );
          expect(databaseEntry).toBeDefined();
          const sqlite = requireNodeSqlite();
          const database = new sqlite.DatabaseSync(path.join(targetPath, databaseEntry ?? ""), {
            readOnly: true,
          });
          try {
            expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
          } finally {
            database.close();
          }
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("accepts an empty directory and refuses a non-empty target", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restore-target-",
        scenario: "minimal",
      },
      async (state) => {
        const archivePath = state.path("backup.tar.gz");
        const emptyTarget = state.path("empty-target");
        const nonEmptyTarget = state.path("non-empty-target");
        const archiveRoot = "2026-08-12T00-00-00.000Z-openclaw-backup";
        const payloadPath = buildBackupArchivePath(archiveRoot, "/tmp/openclaw.json");
        await writeArchive({ archivePath, archiveRoot, payloadPath });
        await fs.mkdir(emptyTarget);
        await fs.mkdir(nonEmptyTarget);
        await fs.writeFile(path.join(nonEmptyTarget, "keep.txt"), "keep\n");

        await expect(
          backupRestoreCommand(createRuntime(), { archive: archivePath, target: emptyTarget }),
        ).resolves.toMatchObject({ targetPath: emptyTarget });
        await expect(
          backupRestoreCommand(createRuntime(), { archive: archivePath, target: nonEmptyTarget }),
        ).rejects.toThrow(/target directory must be empty/iu);
        await expect(fs.readFile(path.join(nonEmptyTarget, "keep.txt"), "utf8")).resolves.toBe(
          "keep\n",
        );
      },
    );
  });

  it("verifies a corrupt archive before touching an empty target", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restore-corrupt-",
        scenario: "minimal",
      },
      async (state) => {
        const archivePath = state.path("corrupt.tar.gz");
        const targetPath = state.path("restore-target");
        const archiveRoot = "2026-08-12T00-00-00.000Z-openclaw-backup";
        const payloadPath = buildBackupArchivePath(archiveRoot, "/tmp/openclaw.json");
        await writeArchive({
          archivePath,
          archiveRoot,
          payloadPath,
          manifest: "{not-json}\n",
        });
        await fs.mkdir(targetPath);

        await expect(
          backupRestoreCommand(createRuntime(), { archive: archivePath, target: targetPath }),
        ).rejects.toThrow(/manifest is not valid JSON/iu);
        await expect(fs.readdir(targetPath)).resolves.toEqual([]);
      },
    );
  });

  it("cleans an incomplete fresh target when extraction fails", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restore-cleanup-",
        scenario: "minimal",
      },
      async (state) => {
        const archivePath = state.path("unextractable.tar.gz");
        const targetPath = state.path("restore-target");
        const archiveRoot = "2026-08-12T00-00-00.000Z-openclaw-backup";
        const assetPath = buildBackupArchivePath(archiveRoot, "/tmp/openclaw.json");
        const directoryPath = `${archiveRoot}/payload/invalid-hardlink-target`;
        await writeArchive({
          archivePath,
          archiveRoot,
          payloadPath: assetPath,
          extraEntries: [
            encodeTarEntry({ path: directoryPath, type: "Directory" }),
            encodeTarEntry({
              path: `${archiveRoot}/payload/directory-hardlink`,
              type: "Link",
              linkpath: directoryPath,
            }),
          ],
        });

        await expect(
          backupRestoreCommand(createRuntime(), { archive: archivePath, target: targetPath }),
        ).rejects.toThrow(/incomplete target was cleaned/iu);
        await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});
