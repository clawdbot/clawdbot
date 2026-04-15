import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";

const legacyCryptoInspectorAvailability = vi.hoisted(() => ({
  available: true,
}));

vi.mock("./legacy-crypto-inspector-availability.js", () => ({
  isMatrixLegacyCryptoInspectorAvailable: () => legacyCryptoInspectorAvailability.available,
}));

import { detectLegacyMatrixCrypto } from "./legacy-crypto.js";
import {
  hasActionableMatrixMigration,
  maybeCreateMatrixMigrationSnapshot,
  resolveMatrixMigrationSnapshotMarkerPath,
  resolveMatrixMigrationSnapshotOutputDir,
} from "./migration-snapshot.js";
import { resolveMatrixAccountStorageRoot } from "./storage-paths.js";

const createBackupArchiveMock = vi.hoisted(() => vi.fn());

describe("matrix migration snapshots", () => {
  beforeEach(() => {
    createBackupArchiveMock.mockReset();
    legacyCryptoInspectorAvailability.available = true;
    createBackupArchiveMock.mockImplementation(
      async (params: { output?: string; includeWorkspace?: boolean }) => {
        const outputDir = params.output;
        if (!outputDir) {
          throw new Error("expected migration snapshot output dir");
        }
        fs.mkdirSync(outputDir, { recursive: true });
        const archivePath = path.join(outputDir, "matrix-migration-backup.tar.gz");
        fs.writeFileSync(archivePath, "archive\n", "utf8");
        return {
          createdAt: "2026-04-05T00:00:00.000Z",
          archivePath,
          includeWorkspace: params.includeWorkspace ?? true,
        };
      },
    );
  });

  it("creates a backup marker after writing a pre-migration snapshot", async () => {
    await withTempHome(async (home) => {
      fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(home, ".openclaw", "state.txt"), "state\n", "utf8");

      const result = await maybeCreateMatrixMigrationSnapshot({
        trigger: "unit-test",
        createBackupArchive: createBackupArchiveMock,
      });

      expect(result.created).toBe(true);
      expect(result.markerPath).toBe(resolveMatrixMigrationSnapshotMarkerPath(process.env));
      expect(
        result.archivePath.startsWith(resolveMatrixMigrationSnapshotOutputDir(process.env)),
      ).toBe(true);
      expect(fs.existsSync(result.archivePath)).toBe(true);
      expect(createBackupArchiveMock).toHaveBeenCalledWith({
        output: resolveMatrixMigrationSnapshotOutputDir(process.env),
        includeWorkspace: false,
      });
    });
  });

  it("treats resolvable Matrix legacy state as actionable", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      fs.mkdirSync(path.join(stateDir, "matrix"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "matrix", "bot-storage.json"),
        '{"legacy":true}',
        "utf8",
      );

      expect(
        hasActionableMatrixMigration({
          cfg: {
            channels: {
              matrix: {
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "tok-123",
              },
            },
          } as never,
          env: process.env,
        }),
      ).toBe(true);
    });
  });

  it("treats legacy Matrix crypto as actionable when the extension inspector is present", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const { rootDir } = resolveMatrixAccountStorageRoot({
        stateDir,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      });
      fs.mkdirSync(path.join(rootDir, "crypto"), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, "crypto", "bot-sdk.json"),
        JSON.stringify({ deviceId: "DEVICE123" }),
        "utf8",
      );

      const cfg = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      } as never;

      const detection = detectLegacyMatrixCrypto({
        cfg,
        env: process.env,
      });
      expect(detection.inspectorAvailable).toBe(true);
      expect(detection.plans).toHaveLength(1);
      expect(detection.warnings).toEqual([]);
      expect(
        hasActionableMatrixMigration({
          cfg,
          env: process.env,
        }),
      ).toBe(true);
    });
  });

  it("keeps legacy Matrix crypto pending but not actionable when the inspector artifact is unavailable", async () => {
    legacyCryptoInspectorAvailability.available = false;

    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const { rootDir } = resolveMatrixAccountStorageRoot({
        stateDir,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      });
      fs.mkdirSync(path.join(rootDir, "crypto"), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, "crypto", "bot-sdk.json"),
        JSON.stringify({ deviceId: "DEVICE123" }),
        "utf8",
      );

      const cfg = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      } as never;

      const detection = detectLegacyMatrixCrypto({
        cfg,
        env: process.env,
      });
      expect(detection.inspectorAvailable).toBe(false);
      expect(detection.plans).toHaveLength(1);
      expect(detection.warnings).toContain(
        "Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.",
      );
      expect(
        hasActionableMatrixMigration({
          cfg,
          env: process.env,
        }),
      ).toBe(false);
    });
  });
});
