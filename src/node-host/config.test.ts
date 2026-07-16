import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { configureNodeHost, loadNodeHostConfig, type NodeHostConfig } from "./config.js";

const fixtureDigest = ["fixture", "digest"].join("-");

function readStoredToken(env: NodeJS.ProcessEnv): string | null | undefined {
  const database = openOpenClawStateDatabase({ env });
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "node_host_config">>(database.db)
      .selectFrom("node_host_config")
      .select("token")
      .where("config_key", "=", "current"),
  )?.token;
}

async function runConcurrentImplicitConfigures(
  stateDir: string,
): Promise<[NodeHostConfig, NodeHostConfig]> {
  const startPath = path.join(stateDir, "configure-start");
  const moduleUrl = new URL("./config.ts", import.meta.url).href;
  const workerSource = `
    import fs from "node:fs";
    const { configureNodeHost } = await import(process.env.OPENCLAW_NODE_HOST_CONFIG_MODULE);
    fs.writeFileSync(process.env.OPENCLAW_NODE_HOST_READY_PATH, "ready");
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(process.env.OPENCLAW_NODE_HOST_START_PATH)) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for concurrent node-host configure start");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const config = await configureNodeHost({
      candidateNodeId: process.env.OPENCLAW_NODE_HOST_CANDIDATE,
      fallbackDisplayName: "node",
      gateway: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: process.env.OPENCLAW_NODE_HOST_STATE_DIR },
      nowMs: Number(process.env.OPENCLAW_NODE_HOST_NOW_MS),
    });
    console.log(JSON.stringify(config));
  `;
  const workers = ["candidate-a", "candidate-b"].map((candidate, index) => {
    const readyPath = path.join(stateDir, `configure-ready-${index}`);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", workerSource],
      {
        env: {
          ...process.env,
          OPENCLAW_NODE_HOST_CANDIDATE: candidate,
          OPENCLAW_NODE_HOST_CONFIG_MODULE: moduleUrl,
          OPENCLAW_NODE_HOST_NOW_MS: String(index + 1),
          OPENCLAW_NODE_HOST_READY_PATH: readyPath,
          OPENCLAW_NODE_HOST_START_PATH: startPath,
          OPENCLAW_NODE_HOST_STATE_DIR: stateDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const outcome = new Promise<NodeHostConfig>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code !== 0) {
          reject(new Error(`configure worker failed (${String(code ?? signal)}): ${stderr}`));
          return;
        }
        const resultLine = stdout.trim().split("\n").at(-1);
        if (!resultLine) {
          reject(new Error("configure worker produced no result"));
          return;
        }
        resolve(JSON.parse(resultLine) as NodeHostConfig);
      });
    });
    return { child, outcome, readyPath };
  });

  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      const ready = await Promise.all(
        workers.map(async ({ readyPath }) =>
          fs.access(readyPath).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (ready.every(Boolean)) {
        break;
      }
      if (workers.some(({ child }) => child.exitCode !== null || child.signalCode !== null)) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for concurrent configure workers");
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
    }
    await fs.writeFile(startPath, "start");
    const outcomes = await Promise.all(workers.map(({ outcome }) => outcome));
    const first = outcomes[0];
    const second = outcomes[1];
    if (!first || !second) {
      throw new Error("expected two concurrent configure results");
    }
    return [first, second];
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  }
}

describe("node-host SQLite config", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function makeTestEnv(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-node-host-config-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, stateDir };
  }

  it("round-trips the complete gateway snapshot across database reopen", async () => {
    const { env, stateDir } = makeTestEnv();
    const configured = await configureNodeHost({
      nodeId: "node-custom",
      displayName: "Build Node",
      fallbackDisplayName: "fallback",
      gateway: {
        host: "gateway.local",
        port: 18443,
        tls: false,
        tlsFingerprint: fixtureDigest,
        contextPath: "/openclaw-gw",
      },
      env,
      nowMs: 1_234,
    });

    expect(configured).toEqual({
      version: 1,
      nodeId: "node-custom",
      displayName: "Build Node",
      gateway: {
        host: "gateway.local",
        port: 18443,
        tls: false,
        tlsFingerprint: fixtureDigest,
        contextPath: "/openclaw-gw",
      },
    });
    closeOpenClawStateDatabaseForTest();
    await expect(loadNodeHostConfig(env)).resolves.toEqual(configured);
    await expect(fs.stat(path.join(stateDir, "node.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("adds the gateway context-path column to an existing state database", async () => {
    const { env } = makeTestEnv();
    const database = openOpenClawStateDatabase({ env });
    database.db.exec("ALTER TABLE node_host_config DROP COLUMN gateway_context_path");
    closeOpenClawStateDatabaseForTest();

    const configured = await configureNodeHost({
      fallbackDisplayName: "node",
      gateway: { contextPath: "/upgraded" },
      env,
      nowMs: 1,
      candidateNodeId: "upgraded-node",
    });

    expect(configured.gateway?.contextPath).toBe("/upgraded");
    const columns = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(node_host_config)")
      .all() as Array<{ name?: unknown }>;
    expect(columns).toContainEqual(expect.objectContaining({ name: "gateway_context_path" }));
  });

  it("keeps the first committed implicit node id across processes", async () => {
    const { env, stateDir } = makeTestEnv();
    const [first, second] = await runConcurrentImplicitConfigures(stateDir);

    expect(["candidate-a", "candidate-b"]).toContain(first.nodeId);
    expect(second.nodeId).toBe(first.nodeId);
    expect(first.gateway).toBeUndefined();
    expect(second.gateway).toBeUndefined();
    await expect(loadNodeHostConfig(env)).resolves.toEqual(second);
  }, 30_000);

  it("preserves explicit custom ids and atomically clears omitted gateway fields", async () => {
    const { env } = makeTestEnv();
    await configureNodeHost({
      nodeId: "first-custom-id",
      fallbackDisplayName: "node",
      gateway: {
        host: "old.example",
        port: 443,
        tls: true,
        tlsFingerprint: fixtureDigest,
        contextPath: "/old",
      },
      env,
      nowMs: 20,
    });
    const configured = await configureNodeHost({
      nodeId: "custom id with spaces inside",
      fallbackDisplayName: "node",
      gateway: { host: "new.example", port: 18789, tls: false },
      env,
      nowMs: 21,
    });

    expect(configured).toMatchObject({
      nodeId: "custom id with spaces inside",
      gateway: { host: "new.example", port: 18789, tls: false },
    });
    expect(configured.gateway?.tlsFingerprint).toBeUndefined();
    expect(configured.gateway?.contextPath).toBeUndefined();
    await expect(loadNodeHostConfig(env)).resolves.toEqual(configured);
  });

  it("rejects corrupt canonical rows instead of rotating identity", async () => {
    const { env } = makeTestEnv();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "node_host_config">>(db)
            .insertInto("node_host_config")
            .values({
              config_key: "current",
              version: 2,
              node_id: "stale-node",
              token: null,
              display_name: null,
              gateway_host: null,
              gateway_port: null,
              gateway_tls: null,
              gateway_tls_fingerprint: null,
              gateway_context_path: null,
              updated_at_ms: 1,
            }),
        );
      },
      { env },
    );

    await expect(loadNodeHostConfig(env)).rejects.toThrow("unsupported version 2");
    await expect(
      configureNodeHost({ fallbackDisplayName: "node", gateway: {}, env }),
    ).rejects.toThrow("unsupported version 2");
  });

  it("never reads legacy token material and nulls it on every configure", async () => {
    const { env } = makeTestEnv();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "node_host_config">>(db)
            .insertInto("node_host_config")
            .values({
              config_key: "current",
              version: 1,
              node_id: "node-with-token",
              token: "test-token-placeholder",
              display_name: null,
              gateway_host: null,
              gateway_port: null,
              gateway_tls: null,
              gateway_tls_fingerprint: null,
              gateway_context_path: null,
              updated_at_ms: 1,
            }),
        );
      },
      { env },
    );

    await expect(loadNodeHostConfig(env)).resolves.toMatchObject({ nodeId: "node-with-token" });
    expect(readStoredToken(env)).toBe("test-token-placeholder");
    await configureNodeHost({ fallbackDisplayName: "node", gateway: {}, env, nowMs: 2 });
    expect(readStoredToken(env)).toBeNull();
  });

  it.each(["source", "claim", "dangling-source-symlink"] as const)(
    "blocks runtime while retired state remains: %s",
    async (kind) => {
      const { env, stateDir } = makeTestEnv();
      const sourcePath = path.join(stateDir, "node.json");
      const claimPath = `${sourcePath}.doctor-importing`;
      if (kind === "source") {
        await fs.writeFile(sourcePath, "{}\n", "utf8");
      } else if (kind === "claim") {
        await fs.writeFile(claimPath, "{}\n", "utf8");
      } else {
        await fs.symlink(path.join(stateDir, "missing-node.json"), sourcePath);
      }

      await expect(loadNodeHostConfig(env)).rejects.toThrow("openclaw doctor --fix");
      await expect(
        configureNodeHost({ fallbackDisplayName: "node", gateway: {}, env }),
      ).rejects.toThrow("openclaw doctor --fix");
    },
  );
});
