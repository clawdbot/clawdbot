import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";

describe("legacy state migration ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function migrationOptions() {
    const stateDir = tempDirs.make("openclaw-state-migration-lock-");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    };
    return {
      env,
      stateDir,
      label: "legacy example state",
      releaseLabel: "Example",
    };
  }

  async function expectStateOwnershipReleased(env: NodeJS.ProcessEnv) {
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      role: "sqlite-maintenance",
      timeoutMs: 100,
    });
    expect(lock).not.toBeNull();
    await lock?.release();
  }

  it("keeps nested cleanup inside exclusive ownership and forwards canonical state env", async () => {
    const options = migrationOptions();
    const events: string[] = [];
    const result = await withLegacyMigrationStateLock({
      ...options,
      beforeRelease: () => {
        events.push("nested-release");
      },
      run: async (env) => {
        events.push("migrate");
        expect(env.OPENCLAW_STATE_DIR).toBe(options.stateDir);
        return { changes: ["imported"], warnings: [], notices: ["verified"] };
      },
    });

    expect(result).toEqual({ changes: ["imported"], warnings: [], notices: ["verified"] });
    expect(events).toEqual(["migrate", "nested-release"]);
    await expectStateOwnershipReleased(options.env);
  });

  it("reports migration failures without retaining exclusive ownership", async () => {
    const options = migrationOptions();
    const result = await withLegacyMigrationStateLock({
      ...options,
      errorLabel: "Failed reading legacy example state",
      run: async () => {
        throw new Error("unsafe source");
      },
    });

    expect(result).toEqual({
      changes: [],
      warnings: ["Failed reading legacy example state: Error: unsafe source"],
    });
    await expectStateOwnershipReleased(options.env);
  });

  it("preserves thrown owner failures when the caller does not request conversion", async () => {
    const options = migrationOptions();
    await expect(
      withLegacyMigrationStateLock({
        ...options,
        run: async () => {
          throw new Error("unexpected owner failure");
        },
      }),
    ).rejects.toThrow("unexpected owner failure");
    await expectStateOwnershipReleased(options.env);
  });

  it("reports nested cleanup failures after releasing the Gateway lock", async () => {
    const options = migrationOptions();
    const result = await withLegacyMigrationStateLock({
      ...options,
      beforeRelease: () => {
        throw new Error("nested release failed");
      },
      run: async () => ({ changes: ["imported"], warnings: [] }),
    });

    expect(result).toEqual({
      changes: ["imported"],
      warnings: ["Example migration lock release failed: nested release failed"],
    });
    await expectStateOwnershipReleased(options.env);
  });

  it("refuses active Gateway ownership without touching the migration source", async () => {
    const options = migrationOptions();
    const owner = await acquireGatewayLock({
      allowInTests: true,
      env: options.env,
      pollIntervalMs: 10,
      port: 18_796,
      timeoutMs: 100,
    });
    if (!owner) {
      throw new Error("expected Gateway lock");
    }
    const run = vi.fn(async () => ({ changes: [], warnings: [] }));
    try {
      const result = await withLegacyMigrationStateLock({
        ...options,
        retryGuidance: "Stop the Gateway and node host, then retry.",
        run,
      });

      expect(result.warnings).toEqual([
        "Failed migrating legacy example state: the Gateway or another SQLite maintenance command owns this state directory. Stop the Gateway and node host, then retry.",
      ]);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await owner.release();
    }
  });
});
