// Config patch tests cover control-UI config edits, secret-ref writes, auth
// profile persistence, and rate limiting through a real Gateway owner.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { resetGatewayRestartStateForInProcessRestart } from "../infra/restart.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { deleteTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GatewayClient, GatewayClientRequestError } from "./client.js";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";
import { startGatewayServerCore } from "./server-start.js";

const CONFIG_SECRETREF_RPC_TIMEOUT_MS = 20_000;
const GATEWAY_TOKEN = "config-rpc-synthetic-token";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
let client: GatewayClient | undefined;
let rateLimitEpochMs = Date.now();
const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));

function requireClient(): GatewayClient {
  if (!client) {
    throw new Error("gateway test client not started");
  }
  return client;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Gateway test RPC helper lets callers ascribe response payload shape.
async function rpcReq<T extends Record<string, unknown>>(
  gatewayClient: GatewayClient,
  method: string,
  params?: unknown,
  timeoutMs = 10_000,
): Promise<{
  ok: boolean;
  payload?: T;
  error?: { message?: string; code?: string; details?: unknown };
}> {
  try {
    return { ok: true, payload: await gatewayClient.request<T>(method, params, { timeoutMs }) };
  } catch (error) {
    if (!(error instanceof GatewayClientRequestError)) {
      throw error;
    }
    return {
      ok: false,
      error: { message: error.message, code: error.code, details: error.details },
    };
  }
}

function requireConfigObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "config-rpc",
    env: {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve(import.meta.dirname, "../../dist/extensions"),
    },
  });
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  await state.writeConfig({ agents: { entries: { main: {} } } });
  hotReloadRecovery.mockClear();
  const port = await getFreePort();
  server = await startGatewayServerCore(port, {
    auth: { mode: "token", token: GATEWAY_TOKEN },
    controlUiEnabled: true,
    hotReloadRecovery,
  });
  const connected = createDeferredCore();
  client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: GATEWAY_TOKEN,
    clientName: "gateway-client",
    clientVersion: "1.0.0",
    platform: "test",
    mode: "backend",
    deviceIdentity: null,
    scopes: ["operator.admin"],
    hostDeps: {
      loadDeviceAuthToken: () => null,
      storeDeviceAuthToken: () => {},
      clearDeviceAuthToken: () => {},
    },
    onHelloOk: () => connected.resolve(),
    onConnectError: (error) => connected.reject(error),
    onClose: (code, reason) => connected.reject(new Error(`closed ${code}: ${reason}`)),
  });
  client.start();
  await withTestTimeout(connected.promise, 10_000, "gateway connect timeout");
  await server.startupSettled;
});

afterEach(async () => {
  // This core fixture has no run loop. Retire direct RPC restart timers before
  // teardown and after its owners drain so they cannot reach the next case.
  await runQaGatewayFixture(
    async () => resetGatewayRestartStateForInProcessRestart(),
    async () => {
      await client?.stopAndWait();
      client = undefined;
    },
    async () => {
      await server?.close();
      server = undefined;
    },
    () => resetGatewayRestartStateForInProcessRestart(),
    () => state?.cleanup(),
    () => resetLogger(),
    () => clearPluginMetadataLifecycleCaches(),
    () => vi.restoreAllMocks(),
    () => expect(hotReloadRecovery).not.toHaveBeenCalled(),
  );
});

async function resetTempDir(name: string): Promise<string> {
  const dir = state.path("fixtures", name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function getConfigHash() {
  const current = await rpcReq<{
    hash?: string;
  }>(requireClient(), "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  return String(current.payload?.hash);
}

async function sendConfigApply(params: { raw: unknown; baseHash?: string }, timeoutMs?: number) {
  return await rpcReq(requireClient(), "config.apply", params, timeoutMs);
}

async function sendConfigSet(params: { raw: string; baseHash?: string }, timeoutMs?: number) {
  return await rpcReq(requireClient(), "config.set", params, timeoutMs);
}

function configRawPayload(config: unknown, baseHash?: string) {
  return {
    raw: JSON.stringify(config, null, 2),
    baseHash,
  };
}

function configWithGatewayTokenSecretRef(config: Record<string, unknown>, envVar: string) {
  const nextConfig = structuredClone(config);
  const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
  gateway.auth = {
    mode: "token",
    token: { source: "env", provider: "default", id: envVar },
  };
  return nextConfig;
}

async function getCurrentConfigObject() {
  const current = await rpcReq<{
    raw?: string | null;
    valid?: boolean;
    hash?: string;
    path?: string;
    config?: Record<string, unknown>;
    sourceConfig?: Record<string, unknown>;
  }>(requireClient(), "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  expect(typeof current.payload?.path).toBe("string");
  return {
    hash: String(current.payload?.hash),
    path: String(current.payload?.path),
    raw: current.payload?.raw,
    valid: current.payload?.valid,
    config: requireConfigObject(current.payload?.sourceConfig, "editable source config"),
    runtimeConfig: requireConfigObject(current.payload?.config, "runtime config"),
  };
}

async function restoreConfigFileForTest(
  original: Awaited<ReturnType<typeof getCurrentConfigObject>>,
) {
  await writeJsonFile(original.path, original.config);
}

function makeRouteBinding(index: number) {
  return {
    agentId: "main",
    match: {
      channel: "telegram",
      peer: {
        kind: "direct",
        id: `user-${index}`,
      },
    },
  };
}

async function expectSchemaLookupInvalid(pathValue: unknown) {
  const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.schema.lookup", {
    pathValue,
  });
  expect(res.ok).toBe(false);
  expect(res.error?.message ?? "").toContain("invalid config.schema.lookup params");
}

async function writeUnresolvedAuthProfileTokenRef(missingEnvVar: string) {
  deleteTestEnvValue(missingEnvVar);
  const authStorePath = path.join(resolveDefaultAgentDir({}), "auth-profiles.json");
  await fs.mkdir(path.dirname(authStorePath), { recursive: true });
  await fs.writeFile(
    authStorePath,
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "custom:token": {
            type: "token",
            provider: "custom",
            tokenRef: { source: "env", provider: "default", id: missingEnvVar },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

beforeEach(() => {
  rateLimitEpochMs += 60_000;
  vi.spyOn(Date, "now").mockReturnValue(rateLimitEpochMs);
});

describe("gateway config methods", () => {
  it("reloads owners independently and reports a changed unresolved owner as cold", async () => {
    const original = await getCurrentConfigObject();
    const secretFile = path.join(await resetTempDir("owner-reload"), "secrets.json");
    await writeJsonFile(secretFile, { first: "first-old", second: "second-old" });
    await fs.chmod(secretFile, 0o600);
    const ref = (id: string) => ({ source: "file", provider: "reload-proof", id });
    const providerConfig = {
      secrets: {
        providers: {
          "reload-proof": { source: "file", path: secretFile, mode: "json" },
        },
      },
      models: {
        providers: {
          "reload-first": {
            apiKey: ref("/first"),
            baseUrl: "https://first.example.invalid/v1",
            models: [],
          },
          "reload-second": {
            apiKey: ref("/second"),
            baseUrl: "https://second.example.invalid/v1",
            models: [],
          },
        },
      },
    };

    try {
      const seed = await rpcReq<{ degradedSecretOwners?: unknown[] }>(
        requireClient(),
        "config.patch",
        {
          raw: JSON.stringify(providerConfig),
          baseHash: original.hash,
        },
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(seed.ok, seed.error?.message).toBe(true);
      expect(seed.payload?.degradedSecretOwners).toBeUndefined();

      await writeJsonFile(secretFile, { second: "second-new" });
      await fs.chmod(secretFile, 0o600);
      const reload = await rpcReq<{ warningCount?: number }>(
        requireClient(),
        "secrets.reload",
        {},
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(reload.ok).toBe(true);
      const stale = getActiveSecretsRuntimeSnapshot();
      expect(stale?.config.models?.providers?.["reload-first"]?.apiKey).toBe("first-old");
      expect(stale?.config.models?.providers?.["reload-second"]?.apiKey).toBe("second-new");
      expect(stale?.degradedOwners).toMatchObject([
        { ownerKind: "provider", ownerId: "reload-first", degradationState: "stale" },
      ]);

      const beforeCold = await getCurrentConfigObject();
      const cold = await rpcReq<{
        degradedSecretOwners?: Array<{ ownerId?: string; state?: string }>;
      }>(
        requireClient(),
        "config.patch",
        {
          raw: JSON.stringify({
            models: {
              providers: {
                "reload-first": { apiKey: ref("/changed") },
              },
            },
          }),
          baseHash: beforeCold.hash,
        },
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(cold.ok).toBe(true);
      expect(cold.payload?.degradedSecretOwners).toEqual([
        expect.objectContaining({ ownerId: "reload-first", state: "cold" }),
      ]);
      const coldSnapshot = getActiveSecretsRuntimeSnapshot();
      expect(coldSnapshot?.config.models?.providers?.["reload-first"]?.apiKey).toEqual(
        ref("/changed"),
      );
      expect(coldSnapshot?.config.models?.providers?.["reload-second"]?.apiKey).toBe("second-new");
    } finally {
      await restoreConfigFileForTest(original);
      activateSecretsRuntimeSnapshot(
        await prepareSecretsRuntimeSnapshot({
          config: original.config,
          includeAuthStoreRefs: true,
        }),
      );
    }
  });

  it("includes the active runtime config revision", async () => {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const { getRuntimeConfigAppliedHash, hashRuntimeConfigValue } =
      await import("../config/runtime-snapshot.js");
    const current = await rpcReq<{
      hash?: string;
      configRevisionHash?: string;
      appliedConfigHash?: string | null;
    }>(requireClient(), "config.get", {});

    expect(current.ok).toBe(true);
    expect(current.payload).toHaveProperty("configRevisionHash");
    expect(current.payload).toHaveProperty("appliedConfigHash");
    const internal = await readConfigFileSnapshot();
    expect(current.payload?.hash).not.toBe(internal.hash);
    expect(current.payload?.configRevisionHash).not.toBe(
      hashRuntimeConfigValue(internal.sourceConfig),
    );
    const internalAppliedHash = getRuntimeConfigAppliedHash();
    if (internalAppliedHash === null) {
      expect(current.payload?.appliedConfigHash).toBeNull();
    } else {
      expect(current.payload?.appliedConfigHash).not.toBe(internalAppliedHash);
    }
  });

  it("rejects the internal raw digest as a public config base hash", async () => {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const current = await getCurrentConfigObject();
    const internal = await readConfigFileSnapshot();
    expect(typeof internal.hash).toBe("string");

    const response = await sendConfigSet(configRawPayload(current.config, internal.hash));

    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain("config changed since last load");
  });

  it("rejects config.set when SecretRef resolution fails", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_${Date.now()}`;
    deleteTestEnvValue(missingEnvVar);
    const current = await getCurrentConfigObject();
    const nextConfig = configWithGatewayTokenSecretRef(current.config, missingEnvVar);

    const res = await sendConfigSet(
      configRawPayload(nextConfig, current.hash),
      CONFIG_SECRETREF_RPC_TIMEOUT_MS,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
    const afterHash = await getConfigHash();
    expect(afterHash).toBe(current.hash);
  });

  it("round-trips config.set and returns the live config path", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const current = await getCurrentConfigObject();

    const res = await rpcReq<{
      ok?: boolean;
      path?: string;
      hash?: string;
      config?: Record<string, unknown>;
    }>(requireClient(), "config.set", {
      ...configRawPayload(current.config, current.hash),
    });

    expect(res.ok, res.error?.message).toBe(true);
    expect(res.payload?.path).toBe(createConfigIO().configPath);
    requireConfigObject(res.payload?.config, "updated config");
    expect(res.payload?.hash).toBe(await getConfigHash());
  });

  it.each([
    { change: "deletes an earlier mapping", ids: ["bravo"], unidentifiedFirst: false },
    { change: "reorders existing mappings", ids: ["bravo", "alpha"], unidentifiedFirst: false },
    { change: "deletes an earlier unidentified mapping", ids: ["bravo"], unidentifiedFirst: true },
  ])(
    "keeps redacted hook secrets with their owner when config.set $change",
    async ({ ids, unidentifiedFirst }) => {
      const original = await getCurrentConfigObject();
      const configured = structuredClone(original.config);
      configured.hooks = {
        ...requireConfigObject(configured.hooks ?? {}, "original hooks config"),
        mappings: [
          {
            ...(unidentifiedFirst ? {} : { id: "alpha" }),
            sessionKey: "synthetic-alpha-session",
          },
          { id: "bravo", sessionKey: "synthetic-bravo-session" },
        ],
      };

      try {
        await writeJsonFile(original.path, configured);
        invalidateConfigGetResponseCache();
        const current = await getCurrentConfigObject();
        const visibleHooks = requireConfigObject(current.config.hooks, "redacted hooks config");
        const visibleMappings = visibleHooks.mappings as Array<{
          id: string;
          sessionKey: string;
        }>;
        expect(visibleMappings.map((mapping) => mapping.sessionKey)).toEqual([
          REDACTED_SENTINEL,
          REDACTED_SENTINEL,
        ]);

        const submitted = structuredClone(current.config);
        const submittedHooks = requireConfigObject(submitted.hooks, "submitted hooks config");
        submittedHooks.mappings = ids.map((id) =>
          visibleMappings.find((mapping) => mapping.id === id),
        );

        const response = await sendConfigSet(configRawPayload(submitted, current.hash));

        expect(response.error).toBeUndefined();
        expect(response.ok).toBe(true);
        expect(JSON.stringify(response.payload)).not.toContain("synthetic-alpha-session");
        expect(JSON.stringify(response.payload)).not.toContain("synthetic-bravo-session");
        const persisted = JSON.parse(await fs.readFile(original.path, "utf-8")) as {
          hooks?: { mappings?: Array<{ id: string; sessionKey: string }> };
        };
        expect(persisted.hooks?.mappings).toEqual(
          ids.map((id) => ({ id, sessionKey: `synthetic-${id}-session` })),
        );
      } finally {
        await restoreConfigFileForTest(original);
        invalidateConfigGetResponseCache();
      }
    },
  );

  it.each([
    { source: "a stale snapshot", legacyDuplicate: false },
    { source: "an invalid duplicate legacy roster", legacyDuplicate: true },
  ])(
    "rejects config.set when $source drops an agent entry without changing disk",
    async ({ legacyDuplicate }) => {
      const original = await getCurrentConfigObject();
      const includedGateway = { mode: "local", reload: { mode: "off" } };
      const includeRaw = `${JSON.stringify(includedGateway, null, 3)}\n`;
      let includePath: string | undefined;
      let rosterConfig = structuredClone(original.config);
      const agents = requireConfigObject(rosterConfig.agents ?? {}, "agents config");
      rosterConfig.agents = {
        ...agents,
        entries: {
          main: { default: true },
          worker: { workspace: "/srv/worker" },
        },
      };
      delete (rosterConfig.agents as Record<string, unknown>).list;

      try {
        if (legacyDuplicate) {
          const configIo = await import("../config/io.js");
          const fixtureIncludePath = path.join(
            path.dirname(original.path),
            "retention-gateway.json",
          );
          await fs.writeFile(fixtureIncludePath, includeRaw, { encoding: "utf-8", flag: "wx" });
          includePath = fixtureIncludePath;
          rosterConfig = {
            agents: {
              list: [
                { id: "Research", name: "First research agent" },
                { id: "Research", name: "Second research agent" },
              ],
            },
            gateway: { $include: path.basename(includePath) },
            plugins: { enabled: false },
          };
          await writeJsonFile(original.path, rosterConfig);
          const snapshot = await configIo.readConfigFileSnapshot();
          expect(snapshot.valid).toBe(false);
          expect(snapshot.parsed).toEqual(rosterConfig);
          expect(snapshot.sourceConfig.gateway).toEqual(includedGateway);
        } else {
          await writeJsonFile(original.path, rosterConfig);
        }
        invalidateConfigGetResponseCache();
        const current = await getCurrentConfigObject();
        const staleConfig = legacyDuplicate
          ? {
              agents: { entries: { research: { name: "First research agent" } } },
              gateway: includedGateway,
              plugins: { enabled: false },
            }
          : structuredClone(current.config);
        if (legacyDuplicate) {
          expect(current.valid).toBe(false);
          expect(current.raw).toBeNull();
          expect(current.hash).not.toBe(original.hash);
        } else {
          const staleAgents = requireConfigObject(staleConfig.agents, "stale agents config");
          const staleEntries = requireConfigObject(staleAgents.entries, "stale agent entries");
          delete staleEntries.worker;
        }
        const before = await fs.readFile(original.path, "utf-8");

        const res = await sendConfigSet(configRawPayload(staleConfig, current.hash));

        await expect(
          fs.readFile(original.path, "utf-8"),
          `config.set response ok=${String(res.ok)}`,
        ).resolves.toBe(before);
        if (includePath) {
          await expect(fs.readFile(includePath, "utf-8")).resolves.toBe(includeRaw);
        }

        expect(res.ok).toBe(false);
        if (legacyDuplicate) {
          expect(res.error?.message ?? "").toContain(
            "Config write would drop agent roster entries without an explicit deletion: research-2.",
          );
        } else {
          expect(res.error?.code).toBe("INVALID_REQUEST");
          expect(res.error?.message ?? "").toContain("worker");
          expect(res.error?.message ?? "").toContain("agents.delete RPC");
          expect(res.error?.message ?? "").toContain("openclaw agents delete");
        }
      } finally {
        await restoreConfigFileForTest(original);
        if (includePath) {
          await fs.rm(includePath, { force: true });
        }
        invalidateConfigGetResponseCache();
      }
    },
  );

  it("accepts config.set when the submitted roster keeps every agent entry", async () => {
    const original = await getCurrentConfigObject();
    const rosterConfig = structuredClone(original.config);
    const agents = requireConfigObject(rosterConfig.agents ?? {}, "agents config");
    rosterConfig.agents = {
      ...agents,
      ownership: "explicit",
      entries: {
        main: {},
        Worker: { workspace: "/srv/worker" },
      },
    };
    delete (rosterConfig.agents as Record<string, unknown>).list;

    try {
      await writeJsonFile(original.path, rosterConfig);
      invalidateConfigGetResponseCache();
      const current = await getCurrentConfigObject();
      const submittedConfig = structuredClone(current.config);
      const submittedAgents = requireConfigObject(
        submittedConfig.agents,
        "submitted agents config",
      );
      const submittedEntries = requireConfigObject(
        submittedAgents.entries,
        "submitted agent entries",
      );
      const worker = submittedEntries.Worker ?? submittedEntries.worker;
      delete submittedEntries.Worker;
      submittedEntries.worker = worker;

      const res = await sendConfigSet(configRawPayload(submittedConfig, current.hash));

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      const persisted = JSON.parse(await fs.readFile(original.path, "utf-8")) as {
        agents?: { entries?: Record<string, unknown> };
      };
      expect(Object.keys(persisted.agents?.entries ?? {}).toSorted()).toEqual(["main", "worker"]);
    } finally {
      await restoreConfigFileForTest(original);
      invalidateConfigGetResponseCache();
    }
  });

  it("invalidates a warm config.get response when config.set commits", async () => {
    const current = await getCurrentConfigObject();
    const nextConfig = structuredClone(current.config);
    delete nextConfig.meta;
    const ui = (nextConfig.ui ??= {}) as Record<string, unknown>;
    const prefs = (ui.prefs ??= {}) as Record<string, unknown>;
    const locale = prefs.locale === "de" ? "en" : "de";
    prefs.locale = locale;

    const res = await rpcReq<{
      ok?: boolean;
      config?: Record<string, unknown>;
      hash?: string;
    }>(requireClient(), "config.set", {
      ...configRawPayload(nextConfig, current.hash),
    });
    expect(res.error).toBeUndefined();
    expect(res.ok, res.error?.message).toBe(true);

    const after = await rpcReq<{
      config?: Record<string, unknown>;
      sourceConfig?: Record<string, unknown>;
      hash?: string;
    }>(requireClient(), "config.get", {});
    expect(after.ok).toBe(true);
    expect(res.payload?.config).toEqual(after.payload?.sourceConfig);
    expect(res.payload?.hash).toBe(after.payload?.hash);
    expect(after.payload?.hash).not.toBe(current.hash);
    expect(
      ((after.payload?.config?.ui as Record<string, unknown>)?.prefs as Record<string, unknown>)
        ?.locale,
    ).toBe(locale);
    requireConfigObject(res.payload?.config, "response config");
  });

  it("accepts runtime-shaped config.set when bundled provider baseUrl was only defaulted", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      });
      invalidateConfigGetResponseCache();

      const current = await getCurrentConfigObject();
      const nextConfig = structuredClone(current.runtimeConfig);
      const providers = ((nextConfig.models as Record<string, unknown>).providers ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      providers.openai ??= {};
      providers.openai.baseUrl = "";
      providers.openai.models = [];

      const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
      gateway.port = 19002;

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireClient(), "config.set", {
        ...configRawPayload(nextConfig, current.hash),
      });

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      const persisted = await fs.readFile(configPath, "utf-8");
      expect(persisted).toContain('"port": 19002');
      expect(persisted).not.toContain('"baseUrl"');
    } finally {
      await fs.rm(configPath, { force: true });
      invalidateConfigGetResponseCache();
    }
  });

  it("accepts config.patch when bundled provider baseUrl was only defaulted", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      });
      invalidateConfigGetResponseCache();

      const current = await getCurrentConfigObject();

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ gateway: { port: 19003 } }),
        baseHash: current.hash,
      });

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      const persisted = await fs.readFile(configPath, "utf-8");
      expect(persisted).toContain('"port": 19003');
      expect(persisted).not.toContain('"baseUrl"');
      expect(persisted).not.toContain('"models": []');
    } finally {
      await fs.rm(configPath, { force: true });
      invalidateConfigGetResponseCache();
    }
  });

  it("preserves authored empty bundled provider models during config.patch", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
              models: [],
            },
          },
        },
      });
      invalidateConfigGetResponseCache();

      const current = await getCurrentConfigObject();

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ gateway: { port: 19004 } }),
        baseHash: current.hash,
      });

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        models?: { providers?: { openai?: { baseUrl?: unknown; models?: unknown } } };
      };
      expect(persisted.models?.providers?.openai?.baseUrl).toBeUndefined();
      expect(persisted.models?.providers?.openai?.models).toEqual([]);
    } finally {
      await fs.rm(configPath, { force: true });
      invalidateConfigGetResponseCache();
    }
  });

  it.each([false, true])(
    "keeps model ID patches source-owned (authored compat: %s)",
    async (authoredCompat) => {
      await withEnvAsync(
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve(import.meta.dirname, "../../dist/extensions"),
        },
        async () => {
          const configIo = await import("../config/io.js");
          const original = await getCurrentConfigObject();
          const textModel = {
            id: "gpt-5.6-luna",
            name: "Text model",
            ...(authoredCompat ? { compat: { supportsStore: false } } : {}),
          };
          try {
            await writeJsonFile(original.path, {
              gateway: { reload: { mode: "off" } },
              models: {
                providers: {
                  openai: { models: [textModel, { id: "gpt-image-1", name: "Image model" }] },
                },
              },
            });
            invalidateConfigGetResponseCache();
            const before = await configIo.readConfigFileSnapshot();
            expect(before.issues).toEqual([]);
            const runtimeModel = before.config.models?.providers?.openai?.models[0];
            expect(runtimeModel?.contextTokens).toBeGreaterThan(0);
            expect(runtimeModel?.compat).toBeDefined();

            const imageModel = {
              id: "gpt-image-1",
              name: "Image model",
              baseUrl: "http://127.0.0.1:44080/v1",
            };
            const res = await rpcReq(requireClient(), "config.patch", {
              raw: JSON.stringify({ models: { providers: { openai: { models: [imageModel] } } } }),
              baseHash: await getConfigHash(),
            });
            expect(res.error).toBeUndefined();
            expect(res.ok, res.error?.message).toBe(true);
            const persisted = JSON.parse(await fs.readFile(original.path, "utf-8"));
            expect(persisted.models.providers.openai.models).toEqual([textModel, imageModel]);

            const after = await configIo.readConfigFileSnapshot();
            expect(after.valid).toBe(true);
            expect(after.config.models?.providers?.openai?.models[0]).toEqual(runtimeModel);
          } finally {
            await restoreConfigFileForTest(original);
            invalidateConfigGetResponseCache();
          }
        },
      );
    },
  );

  it("redacts browser cdpUrl credentials from config.get responses", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        browser: {
          cdpUrl: "https://user:pass@chrome.browserless.io?token=supersecret123",
          profiles: {
            remote: {
              cdpUrl: "https://alice:secret@chrome.remote.example.com?token=profile-secret",
            },
            local: {
              cdpUrl: "ws://127.0.0.1:9222",
            },
          },
        },
      });
      invalidateConfigGetResponseCache();

      const after = await rpcReq<{
        raw?: string | null;
        config?: {
          browser?: {
            cdpUrl?: string;
            profiles?: Record<string, { cdpUrl?: string }>;
          };
        };
      }>(requireClient(), "config.get", {});
      expect(after.ok).toBe(true);
      expect(after.payload?.config?.browser?.cdpUrl).toBe("__OPENCLAW_REDACTED__");
      expect(after.payload?.config?.browser?.profiles?.remote?.cdpUrl).toBe(
        "__OPENCLAW_REDACTED__",
      );
      expect(after.payload?.config?.browser?.profiles?.local?.cdpUrl).toBe("ws://127.0.0.1:9222");
      if (typeof after.payload?.raw === "string") {
        expect(after.payload.raw).toContain("__OPENCLAW_REDACTED__");
        expect(after.payload.raw).not.toContain("supersecret123");
        expect(after.payload.raw).not.toContain("user:pass@");
        expect(after.payload.raw).not.toContain("profile-secret");
        expect(after.payload.raw).not.toContain("alice:secret@");
      }
    } finally {
      await fs.rm(configPath, { force: true });
      invalidateConfigGetResponseCache();
    }
  });

  it("round-trips prototype-like browser profile names through config.patch", async () => {
    const original = await getCurrentConfigObject();
    const profileNames = ["constructor", "prototype"] as const;

    try {
      const create = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({
          browser: {
            profiles: Object.fromEntries(
              profileNames.map((name, index) => [
                name,
                {
                  cdpPort: 18991 + index,
                  constructor: { polluted: true },
                  prototype: { polluted: true },
                },
              ]),
            ),
          },
        }),
        baseHash: original.hash,
      });
      expect(create.ok).toBe(true);

      const afterCreate = await getCurrentConfigObject();
      const browser = requireConfigObject(afterCreate.config.browser, "browser");
      const profiles = requireConfigObject(browser.profiles, "browser.profiles");
      for (const [index, name] of profileNames.entries()) {
        const profile = requireConfigObject(profiles[name], `browser.profiles.${name}`);
        expect(profile.cdpPort).toBe(18991 + index);
        expect(Object.hasOwn(profile, "constructor")).toBe(false);
        expect(Object.hasOwn(profile, "prototype")).toBe(false);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      const remove = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({
          browser: { profiles: { constructor: null, prototype: null } },
        }),
        baseHash: afterCreate.hash,
      });
      expect(remove.ok).toBe(true);

      const afterRemove = await getCurrentConfigObject();
      const afterBrowser = requireConfigObject(afterRemove.config.browser, "browser");
      const afterProfiles = requireConfigObject(afterBrowser.profiles, "browser.profiles");
      for (const name of profileNames) {
        expect(Object.hasOwn(afterProfiles, name)).toBe(false);
      }
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects concurrent config.patch writes that share a stale base hash", async () => {
    const original = await getCurrentConfigObject();
    const names = Array.from({ length: 8 }, (_, index) => `concurrent-mcp-${index}`);

    try {
      const results = await Promise.all(
        names.map((name, index) =>
          rpcReq<{ ok?: boolean; error?: { message?: string } }>(requireClient(), "config.patch", {
            raw: JSON.stringify({
              mcp: {
                servers: {
                  [name]: { command: "node", args: [`server-${index}.mjs`] },
                },
              },
            }),
            baseHash: original.hash,
          }),
        ),
      );

      expect(results.filter((result) => result.ok).length).toBe(1);
      const failures = results.filter((result) => !result.ok);
      expect(failures).toHaveLength(names.length - 1);
      for (const failure of failures) {
        expect(failure.error?.message).toContain("config changed since last load");
      }

      const after = await getCurrentConfigObject();
      const mcp = requireConfigObject(after.config.mcp, "mcp");
      const servers = requireConfigObject(mcp.servers, "mcp.servers");
      expect(names.filter((name) => Object.hasOwn(servers, name))).toHaveLength(1);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("does not reject config.set for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_${Date.now()}`;
    await writeUnresolvedAuthProfileTokenRef(missingEnvVar);

    const current = await getCurrentConfigObject();

    const res = await rpcReq<{ ok?: boolean; error?: { message?: string } }>(
      requireClient(),
      "config.set",
      configRawPayload(current.config, current.hash),
    );

    expect(res.ok, res.error?.message).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("returns config.set validation details in the top-level error message", async () => {
    const res = await rpcReq<{
      ok?: boolean;
      error?: {
        message?: string;
      };
    }>(requireClient(), "config.set", {
      raw: JSON.stringify({ gateway: { bind: 123 } }),
      baseHash: await getConfigHash(),
    });
    const error = res.error as
      | {
          message?: string;
          details?: {
            issues?: Array<{ path?: string; message?: string }>;
          };
        }
      | undefined;

    expect(res.ok).toBe(false);
    expect(error?.message ?? "").toContain("invalid config:");
    expect(error?.message ?? "").toContain("gateway.bind");
    expect(error?.message ?? "").toContain("allowed:");
    expect(error?.details?.issues?.[0]?.path).toBe("gateway.bind");
  });

  it("returns a path-scoped config schema lookup", async () => {
    const res = await rpcReq<{
      path: string;
      hintPath?: string;
      children?: Array<{ key: string; path: string; required: boolean; hintPath?: string }>;
      schema?: { properties?: unknown };
    }>(requireClient(), "config.schema.lookup", {
      path: "gateway.auth",
    });

    expect(res.ok, res.error?.message).toBe(true);
    expect(res.payload?.path).toBe("gateway.auth");
    expect(res.payload?.hintPath).toBe("gateway.auth");
    const tokenChild = res.payload?.children?.find((child) => child.key === "token");
    expect(tokenChild?.key).toBe("token");
    expect(tokenChild?.path).toBe("gateway.auth.token");
    expect(tokenChild?.hintPath).toBe("gateway.auth.token");
    expect(res.payload?.schema?.properties).toBeUndefined();
  });

  it("returns consistent help and reload metadata for plugin enablement", async () => {
    const res = await rpcReq<{
      path: string;
      schema?: { description?: string };
      reloadKind?: string;
      hintPath?: string;
      hint?: { help?: string };
    }>(requireClient(), "config.schema.lookup", {
      path: "plugins.entries.sample-plugin.enabled",
    });

    expect(res.ok, res.error?.message).toBe(true);
    expect(res.payload).toMatchObject({
      path: "plugins.entries.sample-plugin.enabled",
      reloadKind: "hot",
      hintPath: "plugins.entries.*.enabled",
    });
    const description = res.payload?.schema?.description;
    expect(description).toMatch(/default hybrid reload mode/i);
    expect(description).toMatch(/hot-reload the plugin runtime/i);
    expect(description).not.toMatch(/restart required/i);
    expect(res.payload?.hint?.help).toBe(description);
  });

  it("rejects config.schema.lookup when the path is missing", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.schema.lookup", {
      path: "gateway.notReal.path",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("config schema path not found");
  });

  it.each([
    { name: "rejects config.schema.lookup when the path is only whitespace", pathLocal: "   " },
    {
      name: "rejects config.schema.lookup when the path exceeds the protocol limit",
      pathLocal: `gateway.${"a".repeat(1020)}`,
    },
    {
      name: "rejects config.schema.lookup when the path contains invalid characters",
      pathLocal: "gateway.auth\nspoof",
    },
    {
      name: "rejects config.schema.lookup when the path is not a string",
      pathLocal: 42,
    },
  ])("$name", async ({ pathLocal }) => {
    await expectSchemaLookupInvalid(pathLocal);
  });

  it("rejects prototype-chain config.schema.lookup paths without reflecting them", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.schema.lookup", {
      path: "constructor",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("config schema path not found");
  });

  it("returns noop for config.patch when config is unchanged", async () => {
    const current = await rpcReq<{
      config?: Record<string, unknown>;
      hash?: string;
    }>(requireClient(), "config.get", {});
    expect(current.ok).toBe(true);

    // Patch with the same config — no actual changes
    const res = await rpcReq<{
      ok?: boolean;
      noop?: boolean;
      config?: Record<string, unknown>;
    }>(requireClient(), "config.patch", {
      raw: JSON.stringify(current.payload?.config ?? {}),
      baseHash: current.payload?.hash,
    });

    expect(res.ok, res.error?.message).toBe(true);
    expect(res.payload?.noop).toBe(true);
    // Config hash should not change (no file write)
    const after = await rpcReq<{ hash?: string }>(requireClient(), "config.get", {});
    expect(after.payload?.hash).toBe(current.payload?.hash);
  });

  it("acknowledges sandbox config only after the runtime snapshot applies it", async () => {
    const original = await getCurrentConfigObject();
    const image = `openclaw-settlement-${rateLimitEpochMs}:test`;

    try {
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: { defaults: { sandbox: { docker: { image } } } } }),
        baseHash: original.hash,
      });

      expect(res.ok, res.error?.message).toBe(true);
      expect(getRuntimeConfig().agents?.defaults?.sandbox?.docker?.image).toBe(image);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("accepts messages.groupChat.historyLimit: 0 through config.patch", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    let previousConfig: string | null = null;
    try {
      try {
        previousConfig = await fs.readFile(configPath, "utf-8");
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          throw error;
        }
      }
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ messages: { groupChat: { historyLimit: 1 } } }, null, 2)}\n`,
        "utf-8",
      );
      invalidateConfigGetResponseCache();

      const current = await rpcReq<{ hash?: string }>(requireClient(), "config.get", {});
      expect(current.ok).toBe(true);
      expect(typeof current.payload?.hash).toBe("string");

      const res = await rpcReq<{
        config?: { messages?: { groupChat?: { historyLimit?: number } } };
      }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ messages: { groupChat: { historyLimit: 0 } } }),
        baseHash: current.payload?.hash,
      });

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      expect(res.payload?.config?.messages?.groupChat?.historyLimit).toBe(0);
    } finally {
      if (previousConfig === null) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, previousConfig, "utf-8");
      }
      invalidateConfigGetResponseCache();
    }
  });

  it("rejects config.patch when raw is null", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
      raw: "null",
      baseHash: await getConfigHash(),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("raw must be an object");
  });

  it("rejects config.patch that shrinks an existing array without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1, 2].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ bindings: [bindings[0]] }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): bindings",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
      expect(after.config.bindings).toEqual(bindings);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects config.patch that removes existing array entries without shrinking length", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ bindings: [bindings[1], makeRouteBinding(2)] }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): bindings",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
      expect(after.config.bindings).toEqual(bindings);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows config.patch to append array entries without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const nextBindings = [...bindings, makeRouteBinding(2)];
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ bindings: nextBindings }),
        baseHash: before.hash,
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      expect(after.config.bindings).toEqual(nextBindings);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows config.patch to shrink an existing array with replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1, 2].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const replacement = [bindings[0]];
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ bindings: replacement }),
        baseHash: before.hash,
        replacePaths: ["bindings"],
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      expect(after.config.bindings).toEqual(replacement);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("accepts exact numeric record keys in replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const channels =
      original.config.channels &&
      typeof original.config.channels === "object" &&
      !Array.isArray(original.config.channels)
        ? (original.config.channels as Record<string, unknown>)
        : {};
    const discord = {
      ...(channels.discord as Record<string, unknown> | undefined),
      allowFrom: ["*"],
      guilds: {
        "123": {
          channels: {
            general: {
              users: ["111", "222"],
            },
          },
        },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, channels: { ...channels, discord } }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({
          channels: {
            discord: {
              guilds: { "123": { channels: { general: { users: ["111"] } } } },
            },
          },
        }),
        baseHash: before.hash,
        replacePaths: ["channels.discord.guilds.123.channels.general.users"],
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      const afterChannels = requireConfigObject(after.config.channels, "channels");
      expect(
        (
          afterChannels.discord as {
            guilds?: { "123"?: { channels?: { general?: { users?: unknown[] } } } };
          }
        ).guilds?.["123"]?.channels?.general?.users,
      ).toEqual(["111"]);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects nested destructive array patches inside id-keyed arrays without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      ownership: "explicit",
      entries: {
        main: { skills: ["alpha", "beta"] },
        worker: { skills: ["gamma"] },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> }).entries;
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): agents.entries.main.skills",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
      expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual(
        beforeEntries,
      );
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects nested destructive array patches when replacePaths names only a parent object", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      ownership: "explicit",
      entries: {
        main: { skills: ["alpha", "beta"] },
        worker: { skills: ["gamma"] },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> }).entries;
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
        baseHash: before.hash,
        replacePaths: ["agents"],
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): agents.entries.main.skills",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
      expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual(
        beforeEntries,
      );
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects deleting a parent object that contains arrays without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      ownership: "explicit",
      entries: { main: { skills: ["alpha"] }, worker: {} },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: null }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): agents.entries.main.skills",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects deleting a nested parent object inside id-keyed arrays without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      ownership: "explicit",
      entries: {
        main: {
          subagents: { allowAgents: ["worker"] },
        },
        worker: {},
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: { entries: { main: { subagents: null } } } }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): agents.entries.main.subagents.allowAgents",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows nested destructive array patches inside id-keyed arrays with replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      ownership: "explicit",
      entries: {
        main: { skills: ["alpha", "beta"] },
        worker: { skills: ["gamma"] },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> }).entries;
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
        baseHash: before.hash,
        replacePaths: ["agents.entries.main.skills"],
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual({
        ...beforeEntries,
        main: {
          ...(beforeEntries?.main as Record<string, unknown> | undefined),
          skills: ["alpha"],
        },
      });
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects config.patch when merged SecretRefs cannot resolve", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_PATCH_${Date.now()}`;
    deleteTestEnvValue(missingEnvVar);
    const beforeHash = await getConfigHash();
    const res = await rpcReq<{ ok?: boolean; error?: { message?: string } }>(
      requireClient(),
      "config.patch",
      {
        raw: JSON.stringify({
          gateway: {
            auth: {
              mode: "token",
              token: {
                source: "env",
                provider: "default",
                id: missingEnvVar,
              },
            },
          },
        }),
        baseHash: beforeHash,
      },
      CONFIG_SECRETREF_RPC_TIMEOUT_MS,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
    const afterHash = await getConfigHash();
    expect(afterHash).toBe(beforeHash);
  });
});

describe("gateway config.apply", () => {
  it("rejects config.apply when SecretRef resolution fails", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_APPLY_${Date.now()}`;
    deleteTestEnvValue(missingEnvVar);
    const current = await getCurrentConfigObject();
    const nextConfig = configWithGatewayTokenSecretRef(current.config, missingEnvVar);

    const res = await sendConfigApply(
      configRawPayload(nextConfig, current.hash),
      CONFIG_SECRETREF_RPC_TIMEOUT_MS,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");

    const after = await rpcReq<{
      hash?: string;
      raw?: string | null;
    }>(requireClient(), "config.get", {});
    expect(after.ok).toBe(true);
    expect(after.payload?.hash).toBe(current.hash);
    expect(after.payload?.raw).toBe(current.raw);
  });

  it("does not reject config.apply for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_APPLY_${Date.now()}`;
    await writeUnresolvedAuthProfileTokenRef(missingEnvVar);

    const current = await getCurrentConfigObject();

    const res = await sendConfigApply(configRawPayload(current.config, current.hash));
    expect(res.ok, res.error?.message).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("rejects invalid raw config", async () => {
    const currentHash = await getConfigHash();
    const res = await sendConfigApply({ raw: "{", baseHash: currentHash });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid|SyntaxError/i);
  });

  it("requires raw to be a string", async () => {
    const currentHash = await getConfigHash();
    const res = await sendConfigApply({
      raw: { gateway: { mode: "local" } },
      baseHash: currentHash,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("raw");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
