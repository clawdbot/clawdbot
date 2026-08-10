// Windows snapshot repository tests cover native long-path SQLite verification.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPrivateSqliteDirectory } from "../infra/sqlite-private-directory.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import { SNAPSHOT_SQLITE_FILENAME } from "./snapshot-provider.js";

const MAX_PATH = 260;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const windowsPrivateTempRoot = path.dirname(os.tmpdir());

describe("local SQLite snapshot repository on Windows", () => {
  it.runIf(process.platform === "win32")(
    "uses the Windows PowerShell security module when a Core-only module shadows it",
    async () => {
      const tempDir = tempDirs.make(
        "openclaw-snapshot-repository-windows-module-",
        windowsPrivateTempRoot,
      );
      const moduleRoot = path.join(tempDir, "modules");
      const shadowModulePath = path.join(moduleRoot, "Microsoft.PowerShell.Security", "99.0.0");
      await fs.mkdir(shadowModulePath, { recursive: true });
      await fs.writeFile(
        path.join(shadowModulePath, "Microsoft.PowerShell.Security.psd1"),
        "@{ ModuleVersion = '99.0.0'; PowerShellVersion = '7.0'; CompatiblePSEditions = @('Core'); RootModule = 'Microsoft.PowerShell.Security.psm1'; FunctionsToExport = @('Get-Acl') }",
      );
      await fs.writeFile(
        path.join(shadowModulePath, "Microsoft.PowerShell.Security.psm1"),
        "function Get-Acl { throw 'Core-only test module must not be loaded' }; Export-ModuleMember -Function Get-Acl",
      );

      const privateRootPath = path.join(tempDir, "private");
      await createPrivateSqliteDirectory(privateRootPath);
      const sourcePath = path.join(privateRootPath, "source.sqlite");
      const sqlite = requireNodeSqlite();
      new sqlite.DatabaseSync(sourcePath).close();

      await withEnvAsync(
        {
          PSModulePath: [moduleRoot, process.env.PSModulePath].filter(Boolean).join(path.delimiter),
        },
        async () => {
          await expect(
            createLocalSqliteSnapshotProvider({
              repositoryPath: path.join(privateRootPath, "snapshots"),
            }).create({
              path: sourcePath,
              identity: { role: "generic", id: "windows-shadowed-security-module" },
            }),
          ).resolves.toMatchObject({
            manifest: {
              database: { role: "generic", id: "windows-shadowed-security-module" },
            },
          });
        },
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "verifies and cleans staging when the SQLite path exceeds MAX_PATH",
    async () => {
      const tempDir = tempDirs.make(
        "openclaw-snapshot-repository-windows-",
        windowsPrivateTempRoot,
      );
      const privateRootPath = path.join(tempDir, "private");
      await createPrivateSqliteDirectory(privateRootPath);
      const sourcePath = path.join(privateRootPath, "source.sqlite");
      const repositoryPath = path.join(privateRootPath, "snapshots");
      const sqlite = requireNodeSqlite();
      const source = new sqlite.DatabaseSync(sourcePath);
      try {
        source.exec(
          "CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');",
        );
      } finally {
        source.close();
      }

      const shortStagingPath = path.join(
        repositoryPath,
        `.tmp-${"0".repeat(36)}`,
        SNAPSHOT_SQLITE_FILENAME,
      );
      expect(shortStagingPath.length).toBeLessThan(MAX_PATH);
      const snapshot = await createLocalSqliteSnapshotProvider({ repositoryPath }).create({
        path: sourcePath,
        identity: { role: "generic", id: "windows-long-verification-path" },
      });

      let validationRootPath = path.join(privateRootPath, "validation");
      let stagedSqlitePath = path.join(
        validationRootPath,
        `.tmp-verify-${"0".repeat(36)}`,
        SNAPSHOT_SQLITE_FILENAME,
      );
      while (stagedSqlitePath.length <= MAX_PATH) {
        validationRootPath = path.join(validationRootPath, `segment-${"x".repeat(24)}`);
        stagedSqlitePath = path.join(
          validationRootPath,
          `.tmp-verify-${"0".repeat(36)}`,
          SNAPSHOT_SQLITE_FILENAME,
        );
      }
      expect(validationRootPath.length).toBeLessThan(MAX_PATH);
      expect(stagedSqlitePath.length).toBeGreaterThan(MAX_PATH);
      await fs.mkdir(validationRootPath, { recursive: true });
      expect((await fs.lstat(validationRootPath)).isDirectory()).toBe(true);

      const verifier = createLocalSqliteSnapshotProvider({
        repositoryPath,
        validationRootPath,
      });
      await expect(verifier.verify(snapshot.ref)).resolves.toEqual({
        ok: true,
        manifest: snapshot.manifest,
      });
      await expect(fs.readdir(validationRootPath)).resolves.toEqual([]);
    },
  );
});
