// Covers Doctor-only import of the retired device-auth JSON store.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth-store.js";
import { detectLegacyDeviceAuth, migrateLegacyDeviceAuth } from "./state-migrations.device-auth.js";

describe("legacy device-auth Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir() {
    const stateDir = tempDirs.make("openclaw-device-auth-migration-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sourcePath = path.join(stateDir, "identity", "device-auth.json");
    return { stateDir, env, sourcePath };
  }

  async function writeLegacy(
    sourcePath: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: {
            token: "legacy-token",
            role: "operator",
            scopes: ["operator.write"],
            updatedAtMs: 10,
          },
        },
        ...overrides,
      }),
    );
  }

  async function migrate(stateDir: string, env: NodeJS.ProcessEnv) {
    return migrateLegacyDeviceAuth({
      detected: detectLegacyDeviceAuth({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      env,
    });
  }

  it("detects only with Doctor authority and imports verified rows before deleting JSON", async () => {
    const { stateDir, env, sourcePath } = useStateDir();
    await writeLegacy(sourcePath);

    expect(detectLegacyDeviceAuth({ stateDir })).toMatchObject({
      sourcePresent: true,
      hasLegacy: false,
    });
    expect(detectLegacyDeviceAuth({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
      true,
    );

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Migrated 1 device-auth token to SQLite."]);
    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toEqual({
      token: "legacy-token",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      updatedAtMs: 10,
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("preserves canonical SQLite rows instead of replaying stale JSON", async () => {
    const { stateDir, env, sourcePath } = useStateDir();
    storeDeviceAuthToken({
      deviceId: "device-1",
      role: "operator",
      token: "canonical-token",
      env,
    });
    await writeLegacy(sourcePath);

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.notices).toContain("Preserved 1 canonical SQLite device-auth token.");
    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })?.token).toBe(
      "canonical-token",
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("keeps the last legacy token when role aliases normalize to the same key", async () => {
    const { stateDir, env, sourcePath } = useStateDir();
    await writeLegacy(sourcePath, {
      tokens: {
        " operator ": { token: "stale", scopes: [], updatedAtMs: 1 },
        operator: { token: "current", scopes: ["operator.read"], updatedAtMs: 2 },
      },
    });

    await migrate(stateDir, env);

    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })?.token).toBe(
      "current",
    );
  });

  it("keeps invalid legacy state for operator repair", async () => {
    const invalid = useStateDir();
    await fsp.mkdir(path.dirname(invalid.sourcePath), { recursive: true });
    await fsp.writeFile(invalid.sourcePath, '{"version":2}');

    const invalidResult = await migrate(invalid.stateDir, invalid.env);

    expect(invalidResult.warnings.join("\n")).toContain("invalid or unsupported");
    expect(fs.existsSync(invalid.sourcePath)).toBe(true);
  });
});
