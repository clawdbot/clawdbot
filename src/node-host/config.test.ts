import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "../../test/helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { logInfo } from "../logger.js";
import {
  readConfigMachineState,
  readConfigMachineStateWithMetadata,
  writeConfigMachineState,
} from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { nodeHostConfigRuntimeEntrypoint } from "./config-runtime.test-support.js";
import {
  configureNodeHost,
  loadNodeHostConfig,
  NODE_HOST_CONFIG_KEY,
  type NodeHostConfig,
} from "./config.js";

const fixtureDigest = ["fixture", "digest"].join("-");
const fixture = createFixtureLifetime();

vi.mock("../logger.js", () => ({ logInfo: vi.fn() }));

async function runConcurrentImplicitConfigures(
  stateDir: string,
  signal: AbortSignal,
): Promise<[NodeHostConfig, NodeHostConfig]> {
  const workerUrl = resolveRuntimeWorkerUrl(nodeHostConfigRuntimeEntrypoint);
  const cancellation = new AbortController();
  const childSignal = AbortSignal.any([signal, cancellation.signal]);
  const workers = ["candidate-a", "candidate-b"].map((candidate, index) => {
    const ready = createDeferred<ChildProcess>();
    const stderr = createBoundedChildOutput();
    let config: NodeHostConfig | undefined;
    const outcome = fixture.track(
      runManagedCommand({
        bin: process.execPath,
        args: [...resolveRuntimeWorkerArgv(workerUrl), candidate, String(index + 1)],
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        shell: false,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        signal: childSignal,
        requireProcessTreeExit: process.platform !== "win32",
        onReady(child) {
          child.stderr!.on("data", stderr.append);
          child.on("message", (message: "ready" | NodeHostConfig) => {
            if (message === "ready") {
              ready.resolve(child);
            } else {
              config = message;
            }
          });
        },
      }).then((code) => {
        if (code !== 0) {
          throw new Error(`configure worker failed (${code}): ${stderr.text()}`);
        }
        if (!config) {
          throw new Error("configure worker produced no result");
        }
        return config;
      }),
    );
    return {
      ready: Promise.race([
        ready.promise,
        outcome.then(() => {
          throw new Error("configure worker exited before the start barrier");
        }),
      ]),
      outcome,
    };
  });

  try {
    // Both real processes must finish imports before either can choose its implicit id.
    const children = await withTestTimeout(
      Promise.all(workers.map(({ ready }) => ready)),
      15_000,
      "timed out waiting for concurrent configure workers",
    );
    for (const child of children) {
      child.send("start");
    }
    const outcomes = await Promise.all(workers.map(({ outcome }) => outcome));
    const first = outcomes[0];
    const second = outcomes[1];
    if (!first || !second) {
      throw new Error("expected two concurrent configure results");
    }
    return [first, second];
  } finally {
    cancellation.abort();
    await Promise.allSettled(workers.map(({ outcome }) => outcome));
  }
}

describe("node-host SQLite config", () => {
  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fixture.cleanup();
  });

  function makeTestEnv(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = fixture.createTempDir("openclaw-node-host-config-");
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
        cloudflareAccess: {
          clientId: { source: "env", provider: "default", id: "CF_ACCESS_CLIENT_ID" },
          clientSecret: {
            source: "env",
            provider: "default",
            id: "CF_ACCESS_CLIENT_SECRET",
          },
        },
      },
      env,
      nowMs: 1_234,
    });

    expect(configured).toEqual({
      version: 1,
      nodeId: "node-custom",
      displayName: "Build Node",
      installedAppsSharing: false,
      gateway: {
        host: "gateway.local",
        port: 18443,
        tls: false,
        tlsFingerprint: fixtureDigest,
        contextPath: "/openclaw-gw",
        cloudflareAccess: {
          clientId: { source: "env", provider: "default", id: "CF_ACCESS_CLIENT_ID" },
          clientSecret: {
            source: "env",
            provider: "default",
            id: "CF_ACCESS_CLIENT_SECRET",
          },
        },
      },
    });
    expect(readConfigMachineState<NodeHostConfig>(NODE_HOST_CONFIG_KEY, { env })).toEqual(
      configured,
    );
    expect(readConfigMachineStateWithMetadata(NODE_HOST_CONFIG_KEY, { env })?.updatedAtMs).toBe(
      1_234,
    );
    expect(readConfigMachineState(NODE_HOST_CONFIG_KEY, { env })).not.toHaveProperty("token");
    closeOpenClawStateDatabaseForTest();
    await expect(loadNodeHostConfig(env)).resolves.toEqual(configured);
    await expect(fs.stat(path.join(stateDir, "node.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps installed-app sharing disabled by default and persists an explicit enable", async () => {
    const { env } = makeTestEnv();
    const initial = await configureNodeHost({
      fallbackDisplayName: "node",
      gateway: {},
      env,
      nowMs: 1,
    });
    expect(initial.installedAppsSharing).toBe(false);

    const enabled = await configureNodeHost({
      fallbackDisplayName: "node",
      gateway: {},
      installedAppsSharing: true,
      env,
      nowMs: 2,
    });
    expect(enabled.installedAppsSharing).toBe(true);
    closeOpenClawStateDatabaseForTest();
    await expect(loadNodeHostConfig(env)).resolves.toMatchObject({ installedAppsSharing: true });
  });

  it("normalizes command restrictions and preserves them across reopen and endpoint updates", async () => {
    const { env } = makeTestEnv();
    await configureNodeHost({
      fallbackDisplayName: "node",
      gateway: {},
      commands: [" fixture.read ", "fixture.list", "fixture.read"],
      env,
    });
    closeOpenClawStateDatabaseForTest();
    await expect(loadNodeHostConfig(env)).resolves.toMatchObject({
      commands: ["fixture.list", "fixture.read"],
    });
    await expect(
      configureNodeHost({ fallbackDisplayName: "node", gateway: { host: "new.example" }, env }),
    ).resolves.toMatchObject({ commands: ["fixture.list", "fixture.read"] });
    await configureNodeHost({ fallbackDisplayName: "node", gateway: {}, commands: [], env });
    closeOpenClawStateDatabaseForTest();
    await expect(loadNodeHostConfig(env)).resolves.toMatchObject({ commands: [] });
  });

  it("removes a saved command allowlist durably when all commands are selected", async () => {
    vi.mocked(logInfo).mockClear();
    const { env } = makeTestEnv();
    const params = { fallbackDisplayName: "node", gateway: {}, env };
    const restricted = await configureNodeHost({ ...params, commands: ["fixture.read"] });
    const cleared = await configureNodeHost({ ...params, allCommands: true });
    expect(cleared).not.toHaveProperty("commands");
    expect(cleared.nodeId).toBe(restricted.nodeId);
    closeOpenClawStateDatabaseForTest();
    expect(readConfigMachineState(NODE_HOST_CONFIG_KEY, { env })).not.toHaveProperty("commands");
    await expect(loadNodeHostConfig(env)).resolves.not.toHaveProperty("commands");
    await expect(configureNodeHost(params)).resolves.not.toHaveProperty("commands");
    await configureNodeHost({ ...params, allCommands: true });
    expect(logInfo).toHaveBeenCalledExactlyOnceWith(
      "node-host: cleared saved command allowlist; advertising the full default command surface",
    );
  });

  it.each([{ commands: "fixture.read" }, { commands: [""] }, { commands: [42] }])(
    "rejects corrupt command restrictions rather than exposing the full host: $commands",
    async ({ commands }) => {
      const { env } = makeTestEnv();
      writeConfigMachineState(
        NODE_HOST_CONFIG_KEY,
        { version: 1, nodeId: "node", commands },
        { env },
      );
      await expect(loadNodeHostConfig(env)).rejects.toThrow("invalid node-host commands");
    },
  );

  it("keeps the first committed implicit node id across processes", async ({ signal }) => {
    const { env, stateDir } = makeTestEnv();
    const [first, second] = await fixture.run(() =>
      runConcurrentImplicitConfigures(stateDir, signal),
    );

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
    writeConfigMachineState(NODE_HOST_CONFIG_KEY, { version: 2, nodeId: "stale-node" }, { env });

    await expect(loadNodeHostConfig(env)).rejects.toThrow("unsupported version 2");
    await expect(
      configureNodeHost({ fallbackDisplayName: "node", gateway: {}, env }),
    ).rejects.toThrow("unsupported version 2");
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
