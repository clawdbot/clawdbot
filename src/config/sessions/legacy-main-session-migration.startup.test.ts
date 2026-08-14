import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../plugins/legacy-session-surfaces.types.js";
import { runSessionStartupMigration } from "./startup-migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("runs from startup in automatic mode and surfaces unresolved warnings", async () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const migrate = vi.fn(async () => ({
    armed: false,
    changes: [],
    complete: false,
    ledgerComplete: false,
    legacyAgentId: "main",
    mainKey: "main",
    outcomes: [{ kind: "not-armed" as const }],
    warnings: ["owner unresolved"],
  }));
  await runSessionStartupMigration({
    cfg: { session: { store: "/tmp/fixed.sqlite" } },
    log,
    deps: {
      migrateLegacyMainSessionKeys: migrate,
      migrateOrphanedSessionKeys: vi.fn(async () => ({ changes: [], warnings: [] })),
      prepareLegacySessionSurfaces: () => EMPTY_LEGACY_SESSION_SURFACES,
      resolveAllAgentSessionStoreTargetsSync: () => [],
      sweepOrphanSessionStoreTemps: vi.fn(async () => 0),
    },
  });

  expect(migrate).toHaveBeenCalledWith({
    cfg: { session: { store: "/tmp/fixed.sqlite" } },
    env: process.env,
    mode: "automatic",
  });
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("owner unresolved"));
});

it("runs the armed startup engine even when no legacy session directory remains", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-legacy-main-startup-"));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg = { agents: { entries: { ops: {} } } };
  const env = { ...process.env, OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir };
  const migrate = vi.fn(async () => ({
    armed: true,
    changes: [],
    complete: true,
    ledgerComplete: true,
    legacyAgentId: "main",
    mainKey: "main",
    outcomes: [{ kind: "no-legacy-rows" as const }],
    ownerAgentId: "ops",
    warnings: [],
  }));
  const migrateOrphans = vi.fn(async () => ({ changes: [], warnings: [] }));

  const foundLegacyDirectories = await runSessionStartupMigration({
    cfg,
    env,
    log: { info: vi.fn(), warn: vi.fn() },
    deps: {
      migrateLegacyMainSessionKeys: migrate,
      migrateOrphanedSessionKeys: migrateOrphans,
      prepareLegacySessionSurfaces: () => EMPTY_LEGACY_SESSION_SURFACES,
      resolveAllAgentSessionStoreTargetsSync: vi.fn(() => []),
      sweepOrphanSessionStoreTemps: vi.fn(async () => 0),
    },
  });

  expect(foundLegacyDirectories).toBe(false);
  expect(migrate).toHaveBeenCalledWith({ cfg, env, mode: "automatic" });
  expect(migrateOrphans).not.toHaveBeenCalled();
});
