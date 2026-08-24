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
  clearOriginDeviceToken,
  loadDeviceAuthToken,
  loadDeviceAuthTokenReadOnly,
  loadDeviceAuthTokens,
  loadOriginDeviceToken,
  loadOriginDeviceTokenReadOnly,
  storeDeviceAuthToken,
  storeOriginDeviceToken,
} from "./device-auth-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";

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
  it("reads no device auth and creates no database when shared state is absent", async () => {
    await withTempDir("openclaw-device-auth-readonly-missing-", async (stateDir) => {
      const env = createEnv(stateDir);
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

      expect(
        loadDeviceAuthTokenReadOnly({ deviceId: "device-1", role: "operator", env }),
      ).toBeNull();
      expect(
        loadOriginDeviceTokenReadOnly({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toBeNull();
      expect(fs.existsSync(databasePath)).toBe(false);
    });
  });

  it("reads existing device auth without opening writable shared state", async () => {
    await withTempDir("openclaw-device-auth-readonly-", async (stateDir) => {
      const env = createEnv(stateDir);
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "local-token",
        env,
      });
      storeOriginDeviceToken({
        gatewayScope: "wss://one.example",
        deviceId: "device-1",
        role: "operator",
        token: "origin-token",
        env,
      });
      closeOpenClawStateDatabaseForTest();
      const databaseDirectory = path.dirname(path.join(stateDir, "state", "openclaw.sqlite"));
      const artifactsBeforeRead = fs.readdirSync(databaseDirectory).toSorted();

      expect(
        loadDeviceAuthTokenReadOnly({ deviceId: "device-1", role: "operator", env })?.token,
      ).toBe("local-token");
      expect(
        loadOriginDeviceTokenReadOnly({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          env,
        })?.token,
      ).toBe("origin-token");
      expect(fs.readdirSync(databaseDirectory).toSorted()).toEqual(artifactsBeforeRead);
    });
  });

  it("lazily adds origin-scoped tokens without changing the schema version", async () => {
    await withTempDir("openclaw-device-auth-origin-", async (stateDir) => {
      const env = createEnv(stateDir);
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const opened = openOpenClawStateDatabase({ env });
      const version = opened.db.prepare("PRAGMA user_version").get();
      closeOpenClawStateDatabaseForTest();

      const { DatabaseSync } = requireNodeSqlite();
      const beforeEnsure = new DatabaseSync(databasePath);
      beforeEnsure.exec("DROP TABLE gateway_origin_device_tokens;");
      beforeEnsure.close();

      const reopened = openOpenClawStateDatabase({ env });
      expect(
        reopened.db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("gateway_origin_device_tokens"),
      ).toBeUndefined();
      closeOpenClawStateDatabaseForTest();

      expect(
        loadOriginDeviceToken({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toBeNull();
      const afterEnsure = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        afterEnsure
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("gateway_origin_device_tokens"),
      ).toEqual({ name: "gateway_origin_device_tokens" });
      expect(afterEnsure.prepare("PRAGMA user_version").get()).toEqual(version);
      afterEnsure.close();
    });
  });

  it("never exposes a device token to a different gateway origin", async () => {
    await withTempDir("openclaw-device-auth-origin-", async (stateDir) => {
      const env = createEnv(stateDir);
      storeOriginDeviceToken({
        gatewayScope: "wss://one.example/rpc",
        deviceId: "device-1",
        role: "operator",
        token: "origin-one-token",
        env,
      });

      expect(
        loadOriginDeviceToken({
          gatewayScope: "wss://two.example/rpc",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toBeNull();
      clearOriginDeviceToken({
        gatewayScope: "wss://two.example/rpc",
        deviceId: "device-1",
        role: "operator",
        env,
      });
      expect(
        loadOriginDeviceToken({
          gatewayScope: "wss://one.example/rpc",
          deviceId: "device-1",
          role: "operator",
          env,
        })?.token,
      ).toBe("origin-one-token");
    });
  });

  it("upserts and clears only the exact origin, device, and normalized role", async () => {
    await withTempDir("openclaw-device-auth-origin-", async (stateDir) => {
      const env = createEnv(stateDir);
      storeOriginDeviceToken({
        gatewayScope: "wss://one.example",
        deviceId: "device-1",
        role: " operator ",
        token: "old-token",
        scopes: [" operator.write ", "operator.read", "operator.read"],
        env,
      });
      const replacement = storeOriginDeviceToken({
        gatewayScope: "wss://one.example",
        deviceId: "device-1",
        role: "operator",
        token: "new-token",
        scopes: ["operator.pairing"],
        env,
      });
      storeOriginDeviceToken({
        gatewayScope: "wss://two.example",
        deviceId: "device-1",
        role: "operator",
        token: "other-origin-token",
        env,
      });

      expect(replacement).toEqual({
        token: "new-token",
        role: "operator",
        scopes: ["operator.pairing"],
        updatedAtMs: expect.any(Number),
      });
      clearOriginDeviceToken({
        gatewayScope: "wss://one.example",
        deviceId: "device-1",
        role: " operator ",
        env,
      });
      expect(
        loadOriginDeviceToken({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toBeNull();
      expect(
        loadOriginDeviceToken({
          gatewayScope: "wss://two.example",
          deviceId: "device-1",
          role: "operator",
          env,
        })?.token,
      ).toBe("other-origin-token");
    });
  });

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
      openOpenClawStateDatabase({ env }).db.exec("DROP TABLE gateway_origin_device_tokens;");

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
      expect(() =>
        loadOriginDeviceToken({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toThrow("openclaw doctor --fix");
      expect(() =>
        storeOriginDeviceToken({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          token: "origin-token",
          env,
        }),
      ).toThrow("openclaw doctor --fix");
      expect(() =>
        clearOriginDeviceToken({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toThrow("openclaw doctor --fix");
      expect(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("gateway_origin_device_tokens"),
      ).toBeUndefined();
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

  it("keeps credentials rotated after a stale request snapshot", async () => {
    await withTempDir("openclaw-device-auth-rotation-", async (stateDir) => {
      const env = createEnv(stateDir);
      const targets = [
        {
          name: "device",
          load: () => loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env }),
          store: (token: string, expectedToken?: string) =>
            storeDeviceAuthToken({
              deviceId: "device-1",
              role: "operator",
              token,
              scopes: ["operator.read"],
              env,
              ...(expectedToken === undefined ? {} : { expectedToken }),
            }),
          clear: (expectedToken: string) =>
            clearDeviceAuthToken({
              deviceId: "device-1",
              role: "operator",
              env,
              expectedToken,
            }),
        },
        {
          name: "origin",
          load: () =>
            loadOriginDeviceToken({
              gatewayScope: "wss://one.example",
              deviceId: "device-1",
              role: "operator",
              env,
            }),
          store: (token: string, expectedToken?: string) =>
            storeOriginDeviceToken({
              gatewayScope: "wss://one.example",
              deviceId: "device-1",
              role: "operator",
              token,
              scopes: ["operator.read"],
              env,
              ...(expectedToken === undefined ? {} : { expectedToken }),
            }),
          clear: (expectedToken: string) =>
            clearOriginDeviceToken({
              gatewayScope: "wss://one.example",
              deviceId: "device-1",
              role: "operator",
              env,
              expectedToken,
            }),
        },
      ];

      for (const target of targets) {
        const prepared = target.store(`${target.name}-prepared`);
        const rotated = target.store(`${target.name}-rotated`);
        expect(prepared).not.toBeNull();
        expect(rotated).not.toBeNull();

        expect(target.store(`${target.name}-stale-replacement`, prepared!.token)).toBeNull();
        expect(target.clear(prepared!.token)).toBe(false);
        expect(target.load()).toEqual(rotated);
      }
    });
  });
});
