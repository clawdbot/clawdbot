// Covers default device identity SQLite path under the state dir.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { loadDeviceIdentityIfPresent, loadOrCreateDeviceIdentity } from "./device-identity.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("device identity state dir defaults", () => {
  it("writes the default identity to the shared state database", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identity = loadOrCreateDeviceIdentity();
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

      expect(loadDeviceIdentityIfPresent()).toEqual(identity);
      expect(fs.existsSync(databasePath)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "identity", "device.json"))).toBe(false);
    });
  });

  it("reuses the stored identity on subsequent loads", async () => {
    await withStateDirEnv("openclaw-identity-state-", async () => {
      const first = loadOrCreateDeviceIdentity();
      const second = loadOrCreateDeviceIdentity();

      expect(second).toEqual(first);
    });
  });

  it("keeps read-only lookup non-creating when the default database is absent", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

      expect(loadDeviceIdentityIfPresent()).toBeNull();
      expect(fs.existsSync(databasePath)).toBe(false);
    });
  });
});
