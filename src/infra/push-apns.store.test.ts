// Tests canonical shared-SQLite APNs registration persistence.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  loadApnsRegistrations,
  registerApnsRegistration,
} from "./push-apns.js";

const tempDirs = createTrackedTempDirs();
const APNS_DEVICE_FIELD = "token";
const APNS_DEVICE_IDENTIFIER = "ABCD1234ABCD1234ABCD1234ABCD1234";

type TestDatabase = Pick<OpenClawStateKyselyDatabase, "apns_registrations">;

async function makeTempDir(): Promise<string> {
  return await tempDirs.make("openclaw-push-apns-store-test-");
}

async function registerDirectApnsRegistration(params: {
  nodeId: string;
  token?: string;
  topic?: string;
  environment?: unknown;
  baseDir: string;
}) {
  return await registerApnsRegistration({
    [APNS_DEVICE_FIELD]: APNS_DEVICE_IDENTIFIER,
    topic: "ai.openclaw.ios",
    ...params,
    transport: "direct",
  });
}

function databaseEnv(baseDir: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: baseDir };
}

afterEach(async () => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("push APNs registration store", () => {
  it("round-trips direct registrations without creating the retired JSON store", async () => {
    const baseDir = await makeTempDir();
    const saved = await registerDirectApnsRegistration({
      nodeId: "ios-node-1",
      environment: "sandbox",
      baseDir,
    });

    await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toEqual(saved);
    await expect(
      fs.access(path.join(baseDir, "push", "apns-registrations.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores a present valid legacy JSON registration during runtime reads", async () => {
    const baseDir = await makeTempDir();
    const legacyPath = path.join(baseDir, "push", "apns-registrations.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        registrationsByNodeId: {
          "legacy-node": {
            nodeId: "legacy-node",
            [APNS_DEVICE_FIELD]: APNS_DEVICE_IDENTIFIER,
            topic: "ai.openclaw.ios",
            environment: "sandbox",
            updatedAtMs: 1,
          },
        },
      }),
      "utf8",
    );

    await expect(loadApnsRegistration("legacy-node", baseDir)).resolves.toBeNull();
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
  });

  it("round-trips direct and sandbox relay fields including relay origin", async () => {
    const baseDir = await makeTempDir();
    const relay = await registerApnsRegistration({
      nodeId: "ios-node-relay",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      distribution: "official",
      relayOrigin: "https://ios-push-relay-sandbox.openclaw.ai/",
      tokenDebugSuffix: " abcd-1234 ",
      baseDir,
    });

    await expect(loadApnsRegistration("ios-node-relay", baseDir)).resolves.toEqual({
      ...relay,
      relayOrigin: "https://ios-push-relay-sandbox.openclaw.ai",
      tokenDebugSuffix: "abcd1234",
    });
  });

  it("clears transport-specific columns when a node changes registration transport", async () => {
    const baseDir = await makeTempDir();
    await registerDirectApnsRegistration({ nodeId: "ios-node-switch", baseDir });
    await registerApnsRegistration({
      nodeId: "ios-node-switch",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "production",
      distribution: "official",
      baseDir,
    });
    const direct = await registerDirectApnsRegistration({
      nodeId: "ios-node-switch",
      environment: "production",
      baseDir,
    });
    if (direct.transport !== "direct") {
      throw new Error("expected direct APNs registration");
    }

    const database = openOpenClawStateDatabase({ env: databaseEnv(baseDir) });
    const row = database.db
      .prepare("SELECT * FROM apns_registrations WHERE node_id = ?")
      .get("ios-node-switch") as Record<string, unknown>;
    expect(row).toMatchObject({
      transport: "direct",
      [APNS_DEVICE_FIELD]: direct.token,
      relay_handle: null,
      send_grant: null,
      installation_id: null,
      relay_origin: null,
      distribution: null,
      token_debug_suffix: null,
    });
  });

  it("preserves request order, duplicates, and batches above the SQLite bind chunk", async () => {
    const baseDir = await makeTempDir();
    const env = databaseEnv(baseDir);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<TestDatabase>(db);
        for (let index = 0; index < 505; index += 1) {
          const suffix = index.toString().padStart(4, "0");
          executeSqliteQuerySync(
            db,
            stateDb.insertInto("apns_registrations").values({
              node_id: `node-${suffix}`,
              transport: "direct",
              [APNS_DEVICE_FIELD]: APNS_DEVICE_IDENTIFIER.toLowerCase(),
              relay_handle: null,
              send_grant: null,
              installation_id: null,
              relay_origin: null,
              topic: "ai.openclaw.ios",
              environment: "sandbox",
              distribution: null,
              token_debug_suffix: null,
              updated_at_ms: index,
            }),
          );
        }
      },
      { env },
    );
    const requested = [
      ...Array.from({ length: 505 }, (_, index) => `node-${index.toString().padStart(4, "0")}`),
      "node-0000",
      "missing",
    ];

    const loaded = await loadApnsRegistrations(requested, baseDir);
    expect(loaded).toHaveLength(506);
    expect(loaded[0]?.nodeId).toBe("node-0000");
    expect(loaded[504]?.nodeId).toBe("node-0504");
    expect(loaded[505]?.nodeId).toBe("node-0000");
  });

  it("uses monotonic versions so stale compare-and-delete cannot remove a replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T00:00:00Z"));
    const baseDir = await makeTempDir();
    const stale = await registerDirectApnsRegistration({ nodeId: "ios-node-1", baseDir });
    const fresh = await registerDirectApnsRegistration({ nodeId: "ios-node-1", baseDir });

    expect(fresh.updatedAtMs).toBe(stale.updatedAtMs + 1);
    await expect(
      clearApnsRegistrationIfCurrent({
        nodeId: "ios-node-1",
        registration: stale,
        baseDir,
      }),
    ).resolves.toBe(false);
    await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toEqual(fresh);
    await expect(
      clearApnsRegistrationIfCurrent({
        nodeId: "ios-node-1",
        registration: fresh,
        baseDir,
      }),
    ).resolves.toBe(true);
    const database = openOpenClawStateDatabase({ env: databaseEnv(baseDir) });
    expect(
      database.db
        .prepare(
          "SELECT node_id, deleted_at_ms FROM apns_registration_tombstones WHERE node_id = ?",
        )
        .get("ios-node-1"),
    ).toEqual({ node_id: "ios-node-1", deleted_at_ms: fresh.updatedAtMs + 1 });

    const replacement = await registerDirectApnsRegistration({ nodeId: "ios-node-1", baseDir });
    expect(replacement.updatedAtMs).toBe(fresh.updatedAtMs + 2);
    expect(
      database.db
        .prepare("SELECT node_id FROM apns_registration_tombstones WHERE node_id = ?")
        .get("ios-node-1"),
    ).toBeUndefined();
    await expect(
      clearApnsRegistrationIfCurrent({
        nodeId: "ios-node-1",
        registration: fresh,
        baseDir,
      }),
    ).resolves.toBe(false);
    await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toEqual(replacement);
  });

  it("rejects invalid direct and relay inputs", async () => {
    const baseDir = await makeTempDir();
    const oversized = "x".repeat(257);

    await expect(
      registerDirectApnsRegistration({
        nodeId: "ios-node-1",
        [APNS_DEVICE_FIELD]: "not-a-token",
        baseDir,
      }),
    ).rejects.toThrow("invalid APNs token");
    await expect(
      registerDirectApnsRegistration({ nodeId: "n".repeat(257), baseDir }),
    ).rejects.toThrow("nodeId required");
    await expect(
      registerDirectApnsRegistration({ nodeId: "ios-node-1", topic: "a".repeat(256), baseDir }),
    ).rejects.toThrow("topic required");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "staging",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("relay registrations must use valid APNs environment");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: oversized,
        sendGrant: "send-grant-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("relayHandle too long");
  });

  it("fails loudly for a malformed canonical row", async () => {
    const baseDir = await makeTempDir();
    const env = databaseEnv(baseDir);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          `INSERT INTO apns_registrations (
             node_id, transport, topic, environment, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run("corrupt-node", "unknown", "ai.openclaw.ios", "sandbox", 1);
      },
      { env },
    );

    await expect(loadApnsRegistration("corrupt-node", baseDir)).rejects.toThrow(
      "invalid APNs registration row",
    );
  });
});
