// Covers fail-closed Doctor import of the retired node-host JSON config.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadNodeHostConfig } from "../node-host/config.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "node_host_config">;
const fixtureDigest = ["fixture", "digest"].join("-");

describe("legacy node-host Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-node-host-migration-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, stateDir };
  }

  function legacyConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      nodeId: "legacy-node-id",
      token: "test-token-placeholder",
      displayName: "Legacy Node",
      gateway: {
        host: "gateway.example",
        port: 18443,
        tls: false,
        tlsFingerprint: fixtureDigest,
        contextPath: "/openclaw-gw",
      },
      ...overrides,
    };
  }

  async function writeLegacy(
    stateDir: string,
    value: unknown = legacyConfig(),
  ): Promise<{ mtimeMs: number; sourcePath: string }> {
    const sourcePath = path.join(stateDir, "node.json");
    await fsp.writeFile(sourcePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return { sourcePath, mtimeMs: Math.floor((await fsp.stat(sourcePath)).mtimeMs) };
  }

  function seedCanonical(params: {
    env: NodeJS.ProcessEnv;
    nodeId?: string;
    displayName?: string;
    gatewayHost?: string;
    updatedAtMs: number;
    token?: string | null;
  }): void {
    const database = openOpenClawStateDatabase({ env: params.env });
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<NodeHostConfigDatabase>(database.db)
        .insertInto("node_host_config")
        .values({
          config_key: "current",
          version: 1,
          node_id: params.nodeId ?? "legacy-node-id",
          token: params.token ?? null,
          display_name: params.displayName ?? "Legacy Node",
          gateway_host: params.gatewayHost ?? "gateway.example",
          gateway_port: 18443,
          gateway_tls: 0,
          gateway_tls_fingerprint: fixtureDigest,
          gateway_context_path: "/openclaw-gw",
          updated_at_ms: params.updatedAtMs,
        }),
    );
  }

  function readCanonicalRow(env: NodeJS.ProcessEnv) {
    const database = openOpenClawStateDatabase({ env });
    return executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<NodeHostConfigDatabase>(database.db)
        .selectFrom("node_host_config")
        .selectAll()
        .where("config_key", "=", "current"),
    );
  }

  it("detects source and interrupted claim only for explicit Doctor repair", async () => {
    const { stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    expect(detectLegacyNodeHostConfig({ stateDir }).hasLegacy).toBe(false);
    expect(
      detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(
      detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
  });

  it("imports the complete snapshot, discards token, and removes node.json", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Migrated node-host config to shared SQLite state.");
    await expect(loadNodeHostConfig(env)).resolves.toEqual({
      version: 1,
      nodeId: "legacy-node-id",
      displayName: "Legacy Node",
      gateway: {
        host: "gateway.example",
        port: 18443,
        tls: false,
        tlsFingerprint: fixtureDigest,
        contextPath: "/openclaw-gw",
      },
      installedAppsSharing: false,
    });
    expect(readCanonicalRow(env)?.token).toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("normalizes a legacy empty gateway context path to unset", async () => {
    const { env, stateDir } = useStateDir();
    await writeLegacy(
      stateDir,
      legacyConfig({
        gateway: {
          host: "gateway.example",
          port: 18443,
          tls: false,
          tlsFingerprint: fixtureDigest,
          contextPath: "",
        },
      }),
    );

    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect((await loadNodeHostConfig(env))?.gateway?.contextPath).toBeUndefined();
  });

  it("requires exclusive state ownership", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_789,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }
    let blocked: Awaited<ReturnType<typeof migrateLegacyNodeHostConfig>>;
    try {
      blocked = await migrateLegacyNodeHostConfig({
        detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      });
    } finally {
      await gatewayLock.release();
    }

    expect(blocked.warnings[0]).toContain("Gateway or another SQLite maintenance command");
    expect(readCanonicalRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it.each([
    ["unknown top-level field", legacyConfig({ unknown: true }), "unexpected field unknown"],
    ["invalid version", legacyConfig({ version: 2 }), "version must be 1"],
    ["blank node id", legacyConfig({ nodeId: " " }), "nodeId must be a non-empty string"],
    [
      "unknown gateway field",
      legacyConfig({ gateway: { host: "gateway.example", unknown: true } }),
      "unexpected field unknown",
    ],
    ["invalid token", legacyConfig({ token: 42 }), "token must be a string"],
  ])("rejects strict legacy shape: %s", async (_label, value, message) => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir, value);
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings[0]).toContain(message);
    expect(readCanonicalRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("keeps a newer canonical snapshot with the same node id", async () => {
    const { env, stateDir } = useStateDir();
    const { mtimeMs, sourcePath } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      displayName: "Newer Canonical",
      gatewayHost: "newer.example",
      updatedAtMs: mtimeMs + 1_000,
      token: "test-token-placeholder",
    });
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Kept newer canonical node-host SQLite state.");
    expect(readCanonicalRow(env)).toMatchObject({
      display_name: "Newer Canonical",
      gateway_host: "newer.example",
      token: null,
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("replaces an older canonical snapshot from the newer file", async () => {
    const { env, stateDir } = useStateDir();
    const { mtimeMs } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      displayName: "Older Canonical",
      gatewayHost: "older.example",
      updatedAtMs: mtimeMs - 1,
    });
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(readCanonicalRow(env)).toMatchObject({
      display_name: "Legacy Node",
      gateway_host: "gateway.example",
      updated_at_ms: mtimeMs,
    });
  });

  it.each([
    ["different node id", { nodeId: "different-node", equalTimestamp: false }, "nodeId conflicts"],
    [
      "equal timestamp divergence",
      { nodeId: "legacy-node-id", equalTimestamp: true },
      "diverges at the same timestamp",
    ],
  ])("restores source on conflict: %s", async (_label, setup, message) => {
    const { env, stateDir } = useStateDir();
    const { mtimeMs, sourcePath } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      nodeId: setup.nodeId,
      displayName: "Divergent",
      updatedAtMs: setup.equalTimestamp ? mtimeMs : mtimeMs + 1,
    });
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings[0]).toContain(message);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("fails before mutation when the source changes after parsing or before claim", async () => {
    const first = useStateDir();
    const firstLegacy = await writeLegacy(first.stateDir);
    const afterParse = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: first.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: first.env,
      stateDir: first.stateDir,
      beforeVerify: () => fs.appendFileSync(firstLegacy.sourcePath, "\n"),
    });
    expect(afterParse.warnings[0]).toContain("source changed after Doctor loaded it");
    expect(readCanonicalRow(first.env)).toBeUndefined();

    const second = useStateDir();
    const secondLegacy = await writeLegacy(second.stateDir);
    const beforeClaim = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: second.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: second.env,
      stateDir: second.stateDir,
      beforeClaim: () => fs.appendFileSync(secondLegacy.sourcePath, "\n"),
    });
    expect(beforeClaim.warnings[0]).toContain("source changed before Doctor could claim it");
    expect(readCanonicalRow(second.env)).toBeUndefined();
    expect(fs.existsSync(secondLegacy.sourcePath)).toBe(true);
  });

  it("retains a fixed claim on cleanup failure and retries idempotently", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const first = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(readCanonicalRow(env)?.node_id).toBe("legacy-node-id");

    const retry = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(readCanonicalRow(env)?.node_id).toBe("legacy-node-id");
  });

  it("refuses symlinked, hardlinked, and oversized sources", async () => {
    const symlinkCase = useStateDir();
    const outside = path.join(symlinkCase.stateDir, "outside.json");
    await fsp.writeFile(outside, JSON.stringify(legacyConfig()), "utf8");
    const symlinkPath = path.join(symlinkCase.stateDir, "node.json");
    await fsp.symlink(outside, symlinkPath);
    const symlinkResult = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: symlinkCase.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: symlinkCase.env,
      stateDir: symlinkCase.stateDir,
    });
    expect(symlinkResult.warnings[0]).toContain("Failed reading legacy node-host state");

    const hardlinkCase = useStateDir();
    const hardlinkOutside = path.join(hardlinkCase.stateDir, "outside.json");
    await fsp.writeFile(hardlinkOutside, JSON.stringify(legacyConfig()), "utf8");
    const hardlinkPath = path.join(hardlinkCase.stateDir, "node.json");
    await fsp.link(hardlinkOutside, hardlinkPath);
    const hardlinkResult = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: hardlinkCase.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: hardlinkCase.env,
      stateDir: hardlinkCase.stateDir,
    });
    expect(hardlinkResult.warnings[0]).toContain("Failed reading legacy node-host state");

    const oversizedCase = useStateDir();
    await fsp.writeFile(path.join(oversizedCase.stateDir, "node.json"), "x".repeat(65 * 1024));
    const oversizedResult = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: oversizedCase.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: oversizedCase.env,
      stateDir: oversizedCase.stateDir,
    });
    expect(oversizedResult.warnings[0]).toContain("Failed reading legacy node-host state");
  });

  it("fails cleanup when an old writer recreates node.json", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      removeSource: async (claimPath) => {
        await fsp.rm(claimPath);
        await fsp.writeFile(sourcePath, JSON.stringify(legacyConfig()), "utf8");
      },
    });

    expect(result.warnings[0]).toContain("source or Doctor claim remains after cleanup");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(loadNodeHostConfig(env)).rejects.toThrow("openclaw doctor --fix");
  });
});
