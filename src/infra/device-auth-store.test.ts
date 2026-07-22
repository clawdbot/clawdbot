// Covers SQLite-backed device auth token storage and clearing.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  loadDeviceAuthTokens,
  storeDeviceAuthToken,
} from "./device-auth-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("infra/device-auth-store", () => {
  it("stores and loads normalized device auth tokens in SQLite", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      vi.spyOn(Date, "now").mockReturnValue(1234);
      const env = createEnv(stateDir);

      const entry = storeDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        token: "secret",
        scopes: [" operator.write ", "operator.read", "operator.read"],
        env,
      });

      expect(entry).toEqual({
        token: "secret",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        updatedAtMs: 1234,
      });
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toEqual(entry);
      expect(loadDeviceAuthTokens({ deviceId: "device-1", env })).toEqual([entry]);
      expect(fs.existsSync(path.join(stateDir, "identity", "device-auth.json"))).toBe(false);
    });
  });

  it("isolates device ids and overwrites only the normalized role", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3);

      storeDeviceAuthToken({ deviceId: "device-1", role: "node", token: "node", env });
      storeDeviceAuthToken({ deviceId: "device-2", role: "operator", token: "other", env });
      const replacement = storeDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        token: "replacement",
        scopes: ["operator.admin"],
        env,
      });

      expect(loadDeviceAuthTokens({ deviceId: "device-1", env })).toEqual([
        { token: "node", role: "node", scopes: [], updatedAtMs: 1 },
        replacement,
      ]);
      expect(loadDeviceAuthToken({ deviceId: "device-2", role: "operator", env })?.token).toBe(
        "other",
      );
    });
  });

  it("fails closed for malformed canonical scope metadata", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      const { db } = openOpenClawStateDatabase({ env });
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<{
          device_auth_tokens: {
            device_id: string;
            role: string;
            token: string;
            scopes_json: string;
            updated_at_ms: number;
          };
        }>(db)
          .insertInto("device_auth_tokens")
          .values({
            device_id: "device-1",
            role: "operator",
            token: "secret",
            scopes_json: "not-json",
            updated_at_ms: 1,
          }),
      );

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
      expect(loadDeviceAuthTokens({ deviceId: "device-1", env })).toEqual([]);
    });
  });

  it("fails closed with repair guidance while retired JSON remains", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      const legacyPath = path.join(stateDir, "identity", "device-auth.json");
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, '{"version":1}');
      openOpenClawStateDatabase({ env })
        .db.prepare(
          "INSERT INTO device_auth_tokens (device_id, role, token, scopes_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run("device-1", "operator", "sqlite-token", "[]", 1);

      expect(() => loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toThrow(
        "openclaw doctor --fix",
      );
      expect(() =>
        storeDeviceAuthToken({
          deviceId: "device-1",
          role: "operator",
          token: "replacement",
          env,
        }),
      ).toThrow("openclaw doctor --fix");
    });
  });

  it("clears only the requested role and device", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      storeDeviceAuthToken({ deviceId: "device-1", role: "operator", token: "operator", env });
      storeDeviceAuthToken({ deviceId: "device-1", role: "node", token: "node", env });
      storeDeviceAuthToken({ deviceId: "device-2", role: "operator", token: "other", env });

      clearDeviceAuthToken({ deviceId: "device-1", role: " operator ", env });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "node", env })?.token).toBe("node");
      expect(loadDeviceAuthToken({ deviceId: "device-2", role: "operator", env })?.token).toBe(
        "other",
      );
    });
  });
});
