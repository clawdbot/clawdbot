import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const legacyCryptoInspectorAvailability = vi.hoisted(() => ({
  available: true,
}));

vi.mock("./legacy-crypto-inspector-availability.js", () => ({
  isMatrixLegacyCryptoInspectorAvailable: () => legacyCryptoInspectorAvailability.available,
}));

import { runMatrixStartupMaintenance } from "./startup-maintenance.js";
import { resolveMatrixAccountStorageRoot } from "./storage-paths.js";

async function seedLegacyMatrixState(home: string) {
  const stateDir = path.join(home, ".openclaw");
  await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
  await fs.writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"legacy":true}');
}

function makeMatrixStartupConfig(includeCredentials = true) {
  return {
    channels: {
      matrix: includeCredentials
        ? {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          }
        : {
            homeserver: "https://matrix.example.org",
          },
    },
  } as const;
}

async function seedLegacyMatrixCrypto(home: string) {
  const stateDir = path.join(home, ".openclaw");
  const { rootDir } = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "tok-123",
  });
  await fs.mkdir(path.join(rootDir, "crypto"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "crypto", "bot-sdk.json"),
    JSON.stringify({ deviceId: "DEVICE123" }),
    "utf8",
  );
}

function createSuccessfulMatrixMigrationDeps() {
  return {
    maybeCreateMatrixMigrationSnapshot: vi.fn(async () => ({
      created: true,
      archivePath: "/tmp/snapshot.tar.gz",
      markerPath: "/tmp/migration-snapshot.json",
    })),
    autoMigrateLegacyMatrixState: vi.fn(async () => ({
      migrated: true,
      changes: [],
      warnings: [],
    })),
  };
}

function createWarningOnlyMaintenanceHarness() {
  return {
    deps: {
      maybeCreateMatrixMigrationSnapshot: vi.fn(),
      autoMigrateLegacyMatrixState: vi.fn(),
      autoPrepareLegacyMatrixCrypto: vi.fn(),
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

function expectWarningOnlyMaintenanceSkipped(
  harness: ReturnType<typeof createWarningOnlyMaintenanceHarness>,
) {
  expect(harness.deps.maybeCreateMatrixMigrationSnapshot).not.toHaveBeenCalled();
  expect(harness.deps.autoMigrateLegacyMatrixState).not.toHaveBeenCalled();
  expect(harness.deps.autoPrepareLegacyMatrixCrypto).not.toHaveBeenCalled();
  expect(harness.log.info).toHaveBeenCalledWith(
    "matrix: migration remains in a warning-only state; no pre-migration snapshot was needed yet",
  );
}

describe("runMatrixStartupMaintenance", () => {
  beforeEach(() => {
    legacyCryptoInspectorAvailability.available = true;
  });

  it("creates a snapshot before actionable startup migration", async () => {
    await withTempHome(async (home) => {
      await seedLegacyMatrixState(home);
      const deps = createSuccessfulMatrixMigrationDeps();
      const autoPrepareLegacyMatrixCryptoMock = vi.fn(async () => ({
        migrated: false,
        changes: [],
        warnings: [],
      }));

      await runMatrixStartupMaintenance({
        cfg: makeMatrixStartupConfig(),
        env: process.env,
        deps: {
          maybeCreateMatrixMigrationSnapshot: deps.maybeCreateMatrixMigrationSnapshot,
          autoMigrateLegacyMatrixState: deps.autoMigrateLegacyMatrixState,
          autoPrepareLegacyMatrixCrypto: autoPrepareLegacyMatrixCryptoMock,
        },
        log: {},
      });

      expect(deps.maybeCreateMatrixMigrationSnapshot).toHaveBeenCalledWith({
        trigger: "gateway-startup",
        env: process.env,
        log: {},
      });
      expect(deps.autoMigrateLegacyMatrixState).toHaveBeenCalledOnce();
      expect(autoPrepareLegacyMatrixCryptoMock).toHaveBeenCalledOnce();
    });
  });

  it("skips snapshot creation when startup only has warning-only migration state", async () => {
    await withTempHome(async (home) => {
      await seedLegacyMatrixState(home);
      const harness = createWarningOnlyMaintenanceHarness();

      await runMatrixStartupMaintenance({
        cfg: makeMatrixStartupConfig(false),
        env: process.env,
        deps: harness.deps as never,
        log: harness.log,
      });

      expectWarningOnlyMaintenanceSkipped(harness);
      expect(harness.log.warn).toHaveBeenCalledWith(
        `matrix: Legacy Matrix state detected at ${path.join(home, ".openclaw", "matrix")}, but the new account-scoped target could not be resolved yet (need homeserver, userId, and access token for channels.matrix). Start the gateway once with a working Matrix login, or rerun "openclaw doctor --fix" after cached credentials are available.`,
      );
    });
  });

  it("logs the concrete unavailable-inspector warning when startup migration is warning-only", async () => {
    legacyCryptoInspectorAvailability.available = false;

    await withTempHome(async (home) => {
      await seedLegacyMatrixCrypto(home);
      const harness = createWarningOnlyMaintenanceHarness();

      await runMatrixStartupMaintenance({
        cfg: makeMatrixStartupConfig(),
        env: process.env,
        deps: harness.deps as never,
        log: harness.log,
      });

      expectWarningOnlyMaintenanceSkipped(harness);
      expect(harness.log.warn).toHaveBeenCalledWith(
        "matrix: legacy encrypted-state warnings:\n- Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.",
      );
    });
  });

  it("skips startup migration when snapshot creation fails", async () => {
    await withTempHome(async (home) => {
      await seedLegacyMatrixState(home);
      const maybeCreateMatrixMigrationSnapshotMock = vi.fn(async () => {
        throw new Error("backup failed");
      });
      const autoMigrateLegacyMatrixStateMock = vi.fn();
      const autoPrepareLegacyMatrixCryptoMock = vi.fn();
      const warn = vi.fn();

      await runMatrixStartupMaintenance({
        cfg: makeMatrixStartupConfig(),
        env: process.env,
        deps: {
          maybeCreateMatrixMigrationSnapshot: maybeCreateMatrixMigrationSnapshotMock,
          autoMigrateLegacyMatrixState: autoMigrateLegacyMatrixStateMock as never,
          autoPrepareLegacyMatrixCrypto: autoPrepareLegacyMatrixCryptoMock as never,
        },
        log: { warn },
      });

      expect(autoMigrateLegacyMatrixStateMock).not.toHaveBeenCalled();
      expect(autoPrepareLegacyMatrixCryptoMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "gateway: failed creating a Matrix migration snapshot; skipping Matrix migration for now: Error: backup failed",
      );
    });
  });

  it("downgrades migration step failures to warnings so startup can continue", async () => {
    await withTempHome(async (home) => {
      await seedLegacyMatrixState(home);
      const deps = createSuccessfulMatrixMigrationDeps();
      const autoPrepareLegacyMatrixCryptoMock = vi.fn(async () => {
        throw new Error("disk full");
      });
      const warn = vi.fn();

      await expect(
        runMatrixStartupMaintenance({
          cfg: makeMatrixStartupConfig(),
          env: process.env,
          deps: {
            maybeCreateMatrixMigrationSnapshot: deps.maybeCreateMatrixMigrationSnapshot,
            autoMigrateLegacyMatrixState: deps.autoMigrateLegacyMatrixState,
            autoPrepareLegacyMatrixCrypto: autoPrepareLegacyMatrixCryptoMock,
          },
          log: { warn },
        }),
      ).resolves.toBeUndefined();

      expect(deps.maybeCreateMatrixMigrationSnapshot).toHaveBeenCalledOnce();
      expect(deps.autoMigrateLegacyMatrixState).toHaveBeenCalledOnce();
      expect(autoPrepareLegacyMatrixCryptoMock).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "gateway: legacy Matrix encrypted-state preparation failed during Matrix migration; continuing startup: Error: disk full",
      );
    });
  });
});
