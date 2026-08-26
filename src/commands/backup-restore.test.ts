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
  type?: "File" | "Directory" | "Link" | "SymbolicLink";
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
        const pluginSkillTarget = state.statePath("plugin-source", "canvas");
        if (process.platform !== "win32") {
          await fs.mkdir(pluginSkillTarget, { recursive: true });
          await fs.writeFile(path.join(pluginSkillTarget, "SKILL.md"), "# Canvas\n", "utf8");
          const pluginSkillsDir = state.statePath("plugin-skills");
          await fs.mkdir(pluginSkillsDir, { recursive: true });
          await fs.symlink(
            await fs.realpath(pluginSkillTarget),
            path.join(pluginSkillsDir, "canvas"),
            "dir",
          );
        }
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
          expect(restored.warnings.join("\n")).toMatch(/openclaw skills list/iu);
          expect(runtime.log).toHaveBeenCalledOnce();
          expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual(restored);
          if (process.platform !== "win32") {
            expect(backup.skipped).toContainEqual(
              expect.objectContaining({
                sourcePath: state.statePath("plugin-skills"),
                reason: "regenerable",
              }),
            );
            expect(await listArchiveLeafEntries(backup.archivePath)).not.toContainEqual(
              expect.stringContaining("/plugin-skills/"),
            );
            const manifest = JSON.parse(
              await fs.readFile(path.join(targetPath, backup.archiveRoot, "manifest.json"), "utf8"),
            ) as { skipped: Array<{ sourcePath: string; reason: string }> };
            expect(manifest.skipped).toContainEqual(
              expect.objectContaining({
                sourcePath: state.statePath("plugin-skills"),
                reason: "regenerable",
              }),
            );
          }

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

  it("omits agent-scoped temporary trees and preserves safe relative links across restore", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restore-agent-temporary-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const targetPath = state.path("restored");
        const agentRoot = state.statePath("agents", "main", "agent");
        const runtimeHome = path.join(agentRoot, "codex-home");
        const runtimeTempRoot = path.join(runtimeHome, "tmp");
        const marketplaceTempRoot = path.join(runtimeHome, ".tmp");
        const helperDir = path.join(runtimeTempRoot, "arg0", "codex-arg0-fixture");
        const marketplaceDir = path.join(marketplaceTempRoot, "bundled-marketplaces", "managed");
        const agentTempRoot = path.join(agentRoot, "tmp");
        const durableDir = path.join(runtimeHome, "sessions");
        const externalRuntime = state.path("external-runtime");
        const externalExecutable = path.join(externalRuntime, "executable");
        const externalBundle = path.join(externalRuntime, "desktop-bundle");
        await Promise.all(
          [
            outputDir,
            helperDir,
            marketplaceDir,
            path.join(agentTempRoot, "resources"),
            durableDir,
            externalBundle,
          ].map((directory) => fs.mkdir(directory, { recursive: true })),
        );
        await fs.writeFile(externalExecutable, "must never enter the backup\n", "utf8");
        await fs.symlink(externalExecutable, path.join(helperDir, "apply_patch"));
        await fs.symlink(externalBundle, path.join(marketplaceDir, "bundled-plugin"), "dir");
        await fs.writeFile(path.join(agentTempRoot, "resources", "scratch.sqlite"), "not sqlite\n");
        await fs.writeFile(path.join(durableDir, "session.json"), "durable session\n");
        await fs.symlink("session.json", path.join(durableDir, "latest-session"));

        const backup = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 7, 12, 13, 0, 0),
        });

        const omittedRoots = [runtimeTempRoot, marketplaceTempRoot, agentTempRoot].toSorted(
          (left, right) => left.localeCompare(right),
        );
        const expectedOmissions = omittedRoots.map((sourcePath) => ({
          kind: "agent temporary files",
          sourcePath,
          reason: "regenerable",
        }));
        expect(backup.skipped.filter((entry) => entry.kind === "agent temporary files")).toEqual(
          expectedOmissions.map((entry) => expect.objectContaining(entry)),
        );
        expect(backup.skippedVolatileCount).toBe(0);

        const archiveEntries = await listArchiveLeafEntries(backup.archivePath);
        expect(archiveEntries.some((entry) => entry.includes("external-runtime"))).toBe(false);
        expect(archiveEntries.some((entry) => entry.endsWith("/sessions/session.json"))).toBe(true);

        const restored = await backupRestoreCommand(createRuntime(), {
          archive: backup.archivePath,
          target: targetPath,
        });
        expect(restored.symlinkCount).toBe(1);
        const manifest = JSON.parse(
          await fs.readFile(path.join(targetPath, backup.archiveRoot, "manifest.json"), "utf8"),
        ) as { skipped: Array<{ kind: string; sourcePath: string; reason: string }> };
        expect(manifest.skipped.filter((entry) => entry.kind === "agent temporary files")).toEqual(
          expectedOmissions,
        );

        const stateAsset = backup.assets.find((asset) => asset.kind === "state");
        expect(stateAsset).toBeDefined();
        const restoredAgentRoot = path.join(
          targetPath,
          stateAsset?.archivePath ?? "",
          "agents",
          "main",
          "agent",
        );
        for (const omittedRoot of omittedRoots) {
          const relativeRoot = path.relative(agentRoot, omittedRoot);
          const archiveRelativeRoot = relativeRoot.split(path.sep).join("/");
          expect(
            archiveEntries.some((entry) => entry.includes(`/agent/${archiveRelativeRoot}/`)),
          ).toBe(false);
          await expect(fs.lstat(path.join(restoredAgentRoot, relativeRoot))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        await expect(
          fs.readFile(
            path.join(restoredAgentRoot, "codex-home", "sessions", "session.json"),
            "utf8",
          ),
        ).resolves.toBe("durable session\n");
        await expect(
          fs.readlink(path.join(restoredAgentRoot, "codex-home", "sessions", "latest-session")),
        ).resolves.toBe("session.json");
        expect(
          (await listFilesystemLeafEntries(targetPath)).some((entry) =>
            entry.includes("external-runtime"),
          ),
        ).toBe(false);
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

  it("rejects a staging target inside a configured external live agent directory", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restore-external-agent-",
        scenario: "minimal",
      },
      async (state) => {
        const agentDir = state.path("external-agent");
        const targetPath = path.join(agentDir, "restore-target");
        await fs.mkdir(agentDir, { recursive: true });
        await state.writeConfig({ agents: { entries: { main: { agentDir } } } });

        await expect(
          backupRestoreCommand(createRuntime(), {
            archive: state.path("missing-backup.tar.gz"),
            target: targetPath,
          }),
        ).rejects.toThrow(/outside the live OpenClaw agent directory/iu);
        await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("keeps restore available when the live config is malformed", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restore-invalid-config-",
        scenario: "minimal",
      },
      async (state) => {
        const archivePath = state.path("backup.tar.gz");
        const targetPath = state.path("restore-target");
        const archiveRoot = "2026-08-12T00-00-00.000Z-openclaw-backup";
        const payloadPath = buildBackupArchivePath(archiveRoot, "/tmp/openclaw.json");
        await writeArchive({ archivePath, archiveRoot, payloadPath });
        await fs.writeFile(state.configPath, '{"agents":{"entries":', "utf8");

        await expect(
          backupRestoreCommand(createRuntime(), { archive: archivePath, target: targetPath }),
        ).resolves.toMatchObject({ targetPath });
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

  it.each([
    {
      label: "absolute",
      linkpath: "/private/tmp/outside-restore",
      error: /symbolic link target must be relative/iu,
    },
    {
      label: "archive-escaping",
      linkpath: "../../outside-restore",
      error: /symbolic link target is outside the declared archive root/iu,
    },
    {
      label: "backslash-containing",
      linkpath: "nested\\outside-restore",
      error: /symbolic link target must use forward slashes/iu,
    },
    {
      label: "declared-asset-escaping",
      linkpath: "../outside-declared-assets",
      error: /symbolic link is outside the declared backup assets/iu,
      insideDeclaredAsset: true,
    },
    {
      label: "undeclared-entry",
      linkpath: ".",
      error: /symbolic link is outside the declared backup assets/iu,
    },
  ])(
    "rejects $label symlink targets before touching the restore target",
    async ({ linkpath, error, insideDeclaredAsset }) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-restore-absolute-symlink-",
          scenario: "minimal",
        },
        async (state) => {
          const archivePath = state.path("absolute-symlink.tar.gz");
          const targetPath = state.path("restore-target");
          const archiveRoot = "2026-08-12T00-00-00.000Z-openclaw-backup";
          const payloadPath = buildBackupArchivePath(archiveRoot, "/tmp/openclaw.json");
          const declaredAssetRoot = path.posix.dirname(payloadPath);
          await writeArchive({
            archivePath,
            archiveRoot,
            payloadPath,
            ...(insideDeclaredAsset
              ? {
                  manifest: `${JSON.stringify({
                    schemaVersion: 1,
                    createdAt: "2026-08-12T00:00:00.000Z",
                    archiveRoot,
                    assets: [
                      {
                        kind: "config",
                        sourcePath: "/tmp",
                        archivePath: declaredAssetRoot,
                      },
                    ],
                  })}\n`,
                }
              : {}),
            extraEntries: [
              encodeTarEntry({
                path: insideDeclaredAsset
                  ? `${declaredAssetRoot}/unsafe-link`
                  : `${archiveRoot}/payload/absolute-link`,
                type: "SymbolicLink",
                linkpath,
              }),
            ],
          });

          await expect(
            backupRestoreCommand(createRuntime(), { archive: archivePath, target: targetPath }),
          ).rejects.toThrow(error);
          await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    },
  );

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
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("preserves the extraction error when cleanup also fails", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restore-double-failure-",
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
        const cleanupError = new Error("cleanup denied");
        vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupError);

        const restoreError = await backupRestoreCommand(createRuntime(), {
          archive: archivePath,
          target: targetPath,
        }).catch((error: unknown) => error);

        expect(restoreError).toBeInstanceOf(Error);
        expect((restoreError as Error).message).toMatch(/cleanup denied/iu);
        expect((restoreError as Error).cause).toBeInstanceOf(Error);
        expect((restoreError as Error).cause).not.toBe(cleanupError);
        expect((restoreError as AggregateError).errors).toEqual([
          (restoreError as Error).cause,
          cleanupError,
        ]);
      },
    );
  });
});
