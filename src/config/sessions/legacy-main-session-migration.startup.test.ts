import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { runSessionStartupMigration } from "./startup-migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("rejects startup when session-store discovery fails", async () => {
  const stateDir = tempDirs.make("openclaw-startup-discovery-");
  await expect(
    runSessionStartupMigration({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
      log: { info: vi.fn(), warn: vi.fn() },
      deps: {
        resolveAllAgentSessionStoreTargetsSync() {
          throw new Error("session-store discovery failed");
        },
      },
    }),
  ).rejects.toThrow("session-store discovery failed");
});

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
      resolveAllAgentSessionStoreTargetsSync: () => [],
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
  const databases = await runSessionStartupMigration({
    cfg,
    env,
    log: { info: vi.fn(), warn: vi.fn() },
    deps: {
      migrateLegacyMainSessionKeys: migrate,
      resolveAllAgentSessionStoreTargetsSync: vi.fn(() => []),
    },
  });

  expect(databases).toEqual([]);
  expect(migrate).toHaveBeenCalledWith({ cfg, env, mode: "automatic" });
});

it.each([false, true])(
  "includes a newly migrated database and preserves retryable claims (source cleanup fails: %s)",
  async (sourceCleanupFails) => {
    const root = fs.realpathSync.native(tempDirs.make("openclaw-startup-new-agent-store-"));
    const stateDir = path.join(root, "state");
    const workspace = path.join(root, "ops-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    await withEnvAsync(
      { OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir },
      async () => {
        const env = { ...process.env };
        const cfg = { agents: { entries: { ops: { workspace } } } };
        const sourceScope = { agentId: "main", env, sessionKey: "agent:main:worktree" };
        const destinationScope = { agentId: "ops", env, sessionKey: "agent:ops:worktree" };
        const destinationPath = path.join(
          stateDir,
          "agents",
          "ops",
          "agent",
          "openclaw-agent.sqlite",
        );
        const input = {
          sessionId: "transferred-session",
          updatedAt: 10,
          worktree: { id: "legacy", branch: "openclaw/legacy", repoRoot: workspace },
        };
        await replaceSessionEntry(sourceScope, input);
        const original = loadSessionEntry(sourceScope);
        expect(original).toMatchObject(input);
        expect(fs.existsSync(destinationPath)).toBe(false);
        const log = { info: vi.fn(), warn: vi.fn() };
        const runMigration = () => runSessionStartupMigration({ cfg, env, log });
        let databases: Awaited<ReturnType<typeof runMigration>>;
        if (sourceCleanupFails) {
          const registry = createEmptyPluginRegistry();
          registry.agentHarnesses.push({
            pluginId: "core",
            source: "test",
            harness: {
              id: "migration-fixture",
              label: "Migration fixture",
              supports: () => ({ supported: true }),
              async runAttempt() {
                throw new Error("unused");
              },
              async withSessionDeletion() {
                throw new Error("synthetic source cleanup failure");
              },
            },
          });
          markPluginRegistryActive(registry);
          try {
            databases = await withPluginRuntimeRegistryScope(registry, runMigration);
          } finally {
            markPluginRegistryRetired(registry);
          }
          expect(loadSessionEntry(sourceScope)).toEqual(original);
          expect(loadSessionEntry(destinationScope)).toEqual(original);
          expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining("synthetic source cleanup failure"),
          );
          log.warn.mockClear();
          await runMigration();
        } else {
          databases = await runMigration();
        }

        expect(databases).toContainEqual(
          expect.objectContaining({ agentId: "ops", path: destinationPath }),
        );
        expect(loadSessionEntry(sourceScope)).toBeUndefined();
        expect(loadSessionEntry(destinationScope)).toEqual({
          ...original,
          worktree: { ...original?.worktree, canonicalWorkspaceDir: workspace },
        });
        expect(log.warn).not.toHaveBeenCalled();
      },
    );
  },
);
