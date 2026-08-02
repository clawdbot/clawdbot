// Gateway server integration tests cover startup, auth, device pairing, session
// routing, OpenAI-compatible paths, and environment isolation for local servers.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  writeConfigFile,
} from "../config/config.js";
import { resetConfigOverrides, setConfigOverride } from "../config/runtime-overrides.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { callGateway } from "./call.js";
import { startGatewayServer } from "./server.js";
import {
  connectDeviceAuthReq,
  disconnectGatewayClient,
  connectGatewayClient,
  getFreeGatewayPort,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { installOpenAiResponsesMock } from "./test-helpers.openai-mock.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

let createConfigIO: typeof import("../config/config.js").createConfigIO;
const GATEWAY_E2E_TIMEOUT_MS = 90_000;
let gatewayTestSeq = 0;
const GATEWAY_TEST_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function nextGatewayId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${gatewayTestSeq++}`;
}

async function createEmptyBundledPluginsDir(tempHome: string): Promise<string> {
  const bundledPluginsDir = path.join(tempHome, "openclaw-test-empty-bundled-plugins");
  await fs.mkdir(bundledPluginsDir, { recursive: true });
  return bundledPluginsDir;
}

async function createGatewayConfigPath(tempHome: string): Promise<string> {
  const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  return configPath;
}

async function removeGatewayTempHome(tempHome: string): Promise<void> {
  await fs.rm(tempHome, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

async function startLoopbackTokenGateway(token: string) {
  const port = await getFreeGatewayPort();
  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
    sidecarStartup: "defer",
  });
  return { port, server };
}

async function writeWorkspacePlugin(params: {
  workspaceDir: string;
  id: string;
  body: string;
  activation?: { onStartup?: boolean };
}): Promise<void> {
  const pluginDir = path.join(params.workspaceDir, ".openclaw", "extensions", params.id);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: params.id,
        ...(params.activation ? { activation: params.activation } : {}),
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(pluginDir, "index.cjs"), params.body, "utf8");
}

async function readCounterWithRetry(filePath: string): Promise<number> {
  let counter: number | undefined;
  try {
    await expect
      .poll(
        async () => {
          try {
            const raw = await fs.readFile(filePath, "utf8");
            const parsed = Number.parseInt(raw.trim(), 10);
            if (Number.isFinite(parsed)) {
              counter = parsed;
              return true;
            }
          } catch {
            // Wait briefly for gateway startup to finish plugin registration.
          }
          return false;
        },
        { timeout: 1_000, interval: 50 },
      )
      .toBe(true);
  } catch {
    throw new Error(`timed out waiting for counter file: ${filePath}`);
  }
  if (counter === undefined) {
    throw new Error(`timed out waiting for counter file: ${filePath}`);
  }
  return counter;
}

async function setupGatewayTempHome(params: { prefix: string; minimalGateway?: boolean }) {
  const envSnapshot = captureEnv([
    ...GATEWAY_TEST_ENV_KEYS,
    ...(params.minimalGateway ? (["OPENCLAW_TEST_MINIMAL_GATEWAY"] as const) : []),
  ]);

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), params.prefix));
  setTestEnvValue("HOME", tempHome);
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempHome, ".openclaw"));
  deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
  setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
  if (params.minimalGateway) {
    setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
  } else {
    deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
  }

  const workspaceDir = path.join(tempHome, "openclaw");
  await fs.mkdir(workspaceDir, { recursive: true });
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", await createEmptyBundledPluginsDir(tempHome));
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  return { envSnapshot, tempHome, workspaceDir };
}

function resetGatewayTestState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

describe("gateway e2e", () => {
  beforeEach(resetGatewayTestState);

  afterEach(resetGatewayTestState);

  beforeAll(async () => {
    ({ createConfigIO } = await import("../config/config.js"));
  });

  it("pairs the local CLI before a runtime-token loopback gateway becomes ready", async () => {
    const { envSnapshot, tempHome } = await setupGatewayTempHome({
      prefix: "openclaw-gw-runtime-token-cli-pairing-",
    });
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    try {
      deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
      const configPath = await createGatewayConfigPath(tempHome);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      const initialConfig: OpenClawConfig = {
        gateway: { mode: "local", bind: "loopback" },
        logging: { level: "info" },
      };
      await createConfigIO({ configPath }).writeConfigFile(initialConfig);
      const port = await getFreeGatewayPort();
      server = await startGatewayServer(port, {
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });

      await expect(
        callGateway({
          config: initialConfig,
          localPortOverride: port,
          method: "health",
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual(expect.any(Object));

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persisted.gateway?.auth?.token).toBeUndefined();
      const identity = loadOrCreateDeviceIdentity();
      expect(loadDeviceAuthToken({ deviceId: identity.deviceId, role: "operator" })).toMatchObject({
        scopes: expect.arrayContaining(["operator.admin"]),
      });
      await expect(getPairedDevice(identity.deviceId)).resolves.toMatchObject({
        approvedVia: "silent",
        approvedScopes: expect.arrayContaining(["operator.admin"]),
      });
    } finally {
      if (server) {
        await server.close({ reason: "runtime-token local CLI pairing test complete" });
      }
      await removeGatewayTempHome(tempHome);
      envSnapshot.restore();
    }
  });

  it.each(["generated", "explicit-override", "secret-ref-override", "runtime-overrides"] as const)(
    "preserves %s auth across a safe direct gateway reload",
    async (authSource) => {
      const { envSnapshot, tempHome } = await setupGatewayTempHome({
        prefix: "openclaw-gw-direct-reload-",
      });
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
        const fileToken = nextGatewayId("direct-file-token");
        const overrideToken = nextGatewayId("direct-override-token");
        const initialConfig: OpenClawConfig = {
          ...(authSource !== "generated"
            ? {
                gateway: {
                  auth: {
                    mode: "token",
                    token:
                      authSource === "secret-ref-override"
                        ? {
                            source: "env" as const,
                            provider: "default",
                            id: "OPENCLAW_TEST_MISSING_DISK_TOKEN",
                          }
                        : fileToken,
                  },
                },
              }
            : {}),
          ...(authSource === "runtime-overrides"
            ? { channels: { whatsapp: { dmPolicy: "pairing" as const } } }
            : {}),
          logging: { level: "info" },
        };
        const configPath = await createGatewayConfigPath(tempHome);
        setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
        const configIO = createConfigIO({ configPath });
        await configIO.writeConfigFile(initialConfig);
        if (authSource === "secret-ref-override") {
          setTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", overrideToken);
        }
        if (authSource === "runtime-overrides") {
          deleteTestEnvValue("OPENCLAW_SKIP_CHANNELS");
          deleteTestEnvValue("OPENCLAW_SKIP_PROVIDERS");
          setTestEnvValue("OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN", overrideToken);
          expect(
            setConfigOverride("gateway.auth.token", {
              source: "env",
              provider: "default",
              id: "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
            }).ok,
          ).toBe(true);
          expect(
            setConfigOverride("channels.whatsapp", { dmPolicy: "open", allowFrom: ["*"] }).ok,
          ).toBe(true);
        }
        const callerAuthOverride: GatewayAuthConfig | undefined =
          authSource === "explicit-override"
            ? {
                mode: "token" as const,
                token: overrideToken,
                rateLimit: { maxAttempts: 7 },
              }
            : authSource === "secret-ref-override"
              ? {
                  mode: "token",
                  token: {
                    source: "env",
                    provider: "default",
                    id: "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
                  },
                }
              : undefined;
        const callerTailscaleOverride: GatewayTailscaleConfig | undefined =
          authSource === "explicit-override"
            ? { mode: "off" as const, serviceName: "svc:startup" }
            : undefined;
        const port = await getFreeGatewayPort();
        server = await startGatewayServer(port, {
          bind: "loopback",
          ...(callerAuthOverride ? { auth: callerAuthOverride } : {}),
          ...(callerTailscaleOverride ? { tailscale: callerTailscaleOverride } : {}),
          controlUiEnabled: false,
        });
        const expectedToken =
          authSource === "generated" ? getRuntimeConfig().gateway?.auth?.token : overrideToken;
        expect(typeof expectedToken).toBe("string");
        client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: expectedToken as string,
          clientDisplayName: "vitest-direct-reload",
        });

        const health = await client.request<{
          configReload?: { hotReloadStatus?: string };
        }>("health", { probe: true });
        expect(health?.configReload?.hotReloadStatus).toBe("active");

        if (authSource === "runtime-overrides") {
          expect(getRuntimeConfig().channels?.whatsapp?.dmPolicy).toBe("open");
        } else if (callerAuthOverride && callerTailscaleOverride) {
          callerAuthOverride.token = `${overrideToken}-mutated`;
          callerAuthOverride.rateLimit!.maxAttempts = 99;
          callerTailscaleOverride.serviceName = "svc:mutated";
        }
        const nextLoggingSource = {
          ...initialConfig,
          logging: { level: "debug" },
        } satisfies OpenClawConfig;
        await writeConfigFile(nextLoggingSource);
        await expect
          .poll(() => getRuntimeConfig().logging?.level, { timeout: 5_000, interval: 50 })
          .toBe("debug");
        expect(getRuntimeConfig().gateway?.auth?.token).toBe(expectedToken);
        if (authSource === "explicit-override") {
          expect(getRuntimeConfig().gateway?.auth?.rateLimit?.maxAttempts).toBe(7);
          expect(getRuntimeConfig().gateway?.tailscale?.serviceName).toBe("svc:startup");
        }
        if (authSource === "runtime-overrides") {
          expect(getRuntimeConfig().channels?.whatsapp?.dmPolicy).toBe("open");
          expect(getRuntimeConfig().channels?.whatsapp?.allowFrom).toEqual(["*"]);

          const sourceBeforePolicyEdit = (await configIO.readConfigFileSnapshot()).sourceConfig;
          const nextPolicySource = {
            ...sourceBeforePolicyEdit,
            channels: {
              ...sourceBeforePolicyEdit.channels,
              whatsapp: {
                ...sourceBeforePolicyEdit.channels?.whatsapp,
                dmPolicy: "disabled",
              },
            },
          } satisfies OpenClawConfig;
          await writeConfigFile(nextPolicySource);
          const persistedPolicyEdit = JSON.parse(
            await fs.readFile(configPath, "utf-8"),
          ) as OpenClawConfig;
          expect(persistedPolicyEdit.channels?.whatsapp?.dmPolicy).toBe("disabled");
          expect(getRuntimeConfig().channels?.whatsapp?.dmPolicy).toBe("open");

          const sourceBeforeUnrelatedWrite = (await configIO.readConfigFileSnapshot()).sourceConfig;
          const nextUnrelatedSource = {
            ...sourceBeforeUnrelatedWrite,
            ui: { assistant: { name: "unrelated-managed-write" } },
          } satisfies OpenClawConfig;
          await writeConfigFile(nextUnrelatedSource);
          const persistedAfterUnrelatedWrite = JSON.parse(
            await fs.readFile(configPath, "utf-8"),
          ) as OpenClawConfig;
          expect(persistedAfterUnrelatedWrite.channels?.whatsapp?.dmPolicy).toBe("disabled");
          expect(persistedAfterUnrelatedWrite.ui?.assistant?.name).toBe("unrelated-managed-write");
        }

        const reconnected = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: expectedToken as string,
          clientDisplayName: "vitest-direct-reload-reconnect",
        });
        await disconnectGatewayClient(reconnected);
      } finally {
        if (client) {
          await disconnectGatewayClient(client);
        }
        if (server) {
          await server.close({ reason: "direct reload test complete" });
        }
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );

  it(
    "re-resolves a startup auth SecretRef override when secrets reload",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { envSnapshot, tempHome } = await setupGatewayTempHome({
        prefix: "openclaw-gw-startup-auth-ref-",
      });
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let oldClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        const configPath = await createGatewayConfigPath(tempHome);
        setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
        const configIO = createConfigIO({ configPath });
        const fileToken = nextGatewayId("startup-auth-file-token");
        const oldToken = nextGatewayId("startup-auth-ref-old");
        const newToken = nextGatewayId("startup-auth-ref-new");
        await configIO.writeConfigFile({
          gateway: { auth: { mode: "token", token: fileToken } },
          logging: { level: "info" },
        });
        setTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", oldToken);
        const port = await getFreeGatewayPort();
        server = await startGatewayServer(port, {
          bind: "loopback",
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
            },
          },
          controlUiEnabled: false,
        });
        oldClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: oldToken,
          clientDisplayName: "vitest-startup-auth-ref-old",
        });

        setTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", newToken);
        const reload = await oldClient
          .request<{ ok?: boolean }>("secrets.reload", {})
          .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
        if (!(reload instanceof Error)) {
          expect(reload.ok).toBe(true);
        }
        const newClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: newToken,
          clientDisplayName: "vitest-startup-auth-ref-new",
        });
        await disconnectGatewayClient(newClient);

        await writeConfigFile({
          gateway: { auth: { mode: "token", token: fileToken } },
          logging: { level: "debug" },
        });
        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          gateway?: { auth?: { token?: unknown } };
        };
        expect(persisted.gateway?.auth?.token).toBe(fileToken);
      } finally {
        if (oldClient) {
          await disconnectGatewayClient(oldClient);
        }
        if (server) {
          await server.close({ reason: "startup auth SecretRef rotation test complete" });
        }
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );

  it("preserves runtime-seeded Control UI origins across a safe direct reload", async () => {
    const { envSnapshot, tempHome } = await setupGatewayTempHome({
      prefix: "openclaw-gw-direct-origins-",
    });
    const token = nextGatewayId("direct-origins-token");
    const configPath = await createGatewayConfigPath(tempHome);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    const configIO = createConfigIO({ configPath });
    const initialConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token } },
      logging: { level: "info" },
    };
    await configIO.writeConfigFile(initialConfig);
    const port = await getFreeGatewayPort();
    const server = await startGatewayServer(port, {
      bind: "lan",
      controlUiEnabled: false,
    });

    try {
      const seededOrigins = getRuntimeConfig().gateway?.controlUi?.allowedOrigins;
      expect(seededOrigins?.length).toBeGreaterThan(0);

      await writeConfigFile({
        ...initialConfig,
        logging: { level: "debug" },
      });
      await expect
        .poll(() => getRuntimeConfig().logging?.level, { timeout: 5_000, interval: 50 })
        .toBe("debug");
      expect(getRuntimeConfig().gateway?.controlUi?.allowedOrigins).toEqual(seededOrigins);

      expect(setConfigOverride("logging.level", "warn").ok).toBe(true);
      await writeConfigFile({
        ...initialConfig,
        ui: { assistant: { name: "override-active" } },
        logging: { level: "debug" },
      });
      await expect
        .poll(() => getRuntimeConfig().logging?.level, { timeout: 5_000, interval: 50 })
        .toBe("warn");

      resetConfigOverrides();
      await writeConfigFile({
        ...initialConfig,
        ui: { assistant: { name: "override-reset" } },
        logging: { level: "debug" },
      });
      await expect
        .poll(() => getRuntimeConfig().logging?.level, { timeout: 5_000, interval: 50 })
        .toBe("debug");
      expect(getRuntimeConfig().gateway?.controlUi?.allowedOrigins).toEqual(seededOrigins);
    } finally {
      await server.close({ reason: "direct origin reload test complete" });
      await removeGatewayTempHome(tempHome);
      envSnapshot.restore();
    }
  });

  it(
    "applies a hot-reloaded compaction model to automatic chat preflight without restarting",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-gw-compaction-hot-reload-",
      });
      const token = nextGatewayId("compaction-hot-reload-token");
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);

      const providerRequests: Array<{ model: string }> = [];
      const summaryByModel = new Map<string, string>();
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
          const model = body.model ?? "";
          providerRequests.push({ model });
          const text = summaryByModel.get(model) ?? "Primary assistant answer.";
          const message = {
            type: "message",
            id: nextGatewayId("provider-message"),
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          const events = [
            {
              type: "response.output_item.added",
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", item: message },
            {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
              },
            },
          ];
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of events) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
        })().catch((error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("mock OpenAI Responses server did not bind a loopback port");
        }
        const baseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
        const primaryModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-primary");
        const oldCompactionModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-old-summary");
        const newCompactionModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-new-summary");
        const newSummary = "HOT_RELOAD_COMPACTION_SUMMARY";
        summaryByModel.set(oldCompactionModel.modelId, "STALE_COMPACTION_SUMMARY");
        summaryByModel.set(newCompactionModel.modelId, newSummary);

        const initialConfig = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: primaryModel.modelRef },
              models: {
                [primaryModel.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                [oldCompactionModel.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
                [newCompactionModel.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
              compaction: {
                model: oldCompactionModel.modelRef,
                maxActiveTranscriptBytes: "1mb",
                keepRecentTokens: 1,
                recentTurnsPreserve: 1,
                qualityGuard: { enabled: false },
                memoryFlush: { enabled: false },
              },
            },
            entries: { dev: { default: true } },
          },
          models: {
            mode: "replace",
            providers: {
              [primaryModel.providerId]: {
                ...primaryModel.config,
                models: [primaryModel, oldCompactionModel, newCompactionModel].map(({ config }) => ({
                  ...config.models[0],
                  input: [...config.models[0].input],
                })),
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
        } satisfies OpenClawConfig;

        const configPath = await createGatewayConfigPath(tempHome);
        gateway = await startGatewayWithClient({
          cfg: initialConfig,
          configPath,
          token,
          clientDisplayName: "vitest-compaction-hot-reload",
        });
        const gatewayClient = gateway.client;
        const sessionKey = "agent:dev:main";
        const sessionId = nextGatewayId("existing-compaction-session");
        const scope = {
          agentId: "dev",
          sessionId,
          sessionKey,
          storePath: resolveStorePath(undefined, { agentId: "dev" }),
        };
        await upsertSessionEntry(scope, {
          sessionId,
          updatedAt: Date.now(),
          compactionCount: 0,
          modelProvider: primaryModel.providerId,
          model: primaryModel.modelId,
          totalTokens: 20,
          totalTokensFresh: true,
        });
        for (let turn = 0; turn < 6; turn += 1) {
          const timestamp = Date.now() + turn;
          await appendTranscriptMessage(scope, {
            message: {
              role: "user",
              content: `Historical request ${turn}: ${"persisted conversation ".repeat(24)}`,
              timestamp,
            },
            now: timestamp,
          });
          await appendTranscriptMessage(scope, {
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `Historical answer ${turn}: ${"durable model context ".repeat(24)}`,
                },
              ],
              api: "openai-responses",
              provider: primaryModel.providerId,
              model: primaryModel.modelId,
              usage: {
                input: 10,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 20,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp,
            },
            now: timestamp,
          });
        }
        expect(loadTranscriptEventsSync(scope).length).toBeGreaterThan(10);

        const sendChatAndWait = async (message: string) => {
          const started = await gatewayClient.request<{ runId: string; status: string }>(
            "chat.send",
            { sessionKey, message, idempotencyKey: nextGatewayId("compaction-chat") },
          );
          expect(started.status).toBe("started");
          const completed = await gatewayClient.request<{ status: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          );
          expect(completed.status).toBe("ok");
        };

        await sendChatAndWait("Warm the existing prepared model runtime.");
        expect(providerRequests.map(({ model }) => model)).toContain(primaryModel.modelId);
        expect(loadSessionEntry(scope)?.compactionCount ?? 0).toBe(0);

        await writeConfigFile({
          ...initialConfig,
          agents: {
            ...initialConfig.agents,
            defaults: {
              ...initialConfig.agents.defaults,
              compaction: {
                ...initialConfig.agents.defaults.compaction,
                model: newCompactionModel.modelRef,
                maxActiveTranscriptBytes: "10b",
              },
            },
          },
        });
        await expect
          .poll(() => getRuntimeConfig().agents?.defaults?.compaction?.model, {
            timeout: 5_000,
            interval: 50,
          })
          .toBe(newCompactionModel.modelRef);
        await expect
          .poll(() => getRuntimeConfig().agents?.defaults?.compaction?.maxActiveTranscriptBytes, {
            timeout: 5_000,
            interval: 50,
          })
          .toBe("10b");

        const requestsBeforeCompaction = providerRequests.length;
        await sendChatAndWait("Compact the existing conversation before answering.");

        const newRequests = providerRequests.slice(requestsBeforeCompaction);
        expect(newRequests.map(({ model }) => model)).toContain(newCompactionModel.modelId);
        expect(newRequests.map(({ model }) => model)).not.toContain(oldCompactionModel.modelId);
        expect(loadSessionEntry(scope)?.compactionCount).toBe(1);
        expect(loadTranscriptEventsSync(scope)).toContainEqual(
          expect.objectContaining({
            type: "compaction",
            summary: expect.stringContaining(newSummary),
          }),
        );
        await expect(gatewayClient.request("health", {})).resolves.toEqual(expect.any(Object));
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "compaction hot reload integration test complete" });
        }
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => providerServer.close(() => resolve()));
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );

  it(
    "accepts a gateway agent request over ws and returns a run id",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { baseUrl: openaiBaseUrl, restore } = installOpenAiResponsesMock();
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-gw-mock-home-",
        minimalGateway: true,
      });

      const token = nextGatewayId("test-token");
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);

      const configPath = await createGatewayConfigPath(tempHome);
      const mockProvider = buildMockOpenAiResponsesProvider(openaiBaseUrl);

      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: { primary: mockProvider.modelRef },
            models: {
              [mockProvider.modelRef]: {
                params: {
                  transport: "sse",
                  openaiWsWarmup: false,
                },
              },
            },
          },
          // The request below runs sessionKey "agent:dev:mock-openai"; the
          // gateway rejects session keys whose agent id is not declared.
          entries: { dev: { default: true } },
        },
        models: {
          mode: "replace",
          providers: {
            [mockProvider.providerId]: mockProvider.config,
          },
        },
        gateway: { auth: { token } },
      };

      const { server, client } = await startGatewayWithClient({
        cfg,
        configPath,
        token,
        clientDisplayName: "vitest-mock-openai",
      });

      try {
        const sessionKey = "agent:dev:mock-openai";

        const runId = nextGatewayId("run");
        const payload = await client.request(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${runId}`,
            message: "Reply with ok.",
            deliver: false,
          },
          { expectFinal: false },
        );

        expect(payload?.status).toBe("accepted");
        expect(typeof payload?.runId).toBe("string");

        const abortPayload = await client.request(
          "sessions.abort",
          { runId: payload.runId },
          { timeoutMs: 5_000 },
        );
        expect(["aborted", "no-active-run"]).toContain(abortPayload?.status);
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "mock openai test complete" });
        await removeGatewayTempHome(tempHome);
        restore();
        envSnapshot.restore();
      }
    },
  );

  it(
    "does not reload workspace plugins when POST /tools/invoke rebuilds tools for the same workspace",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-gw-http-tools-home-",
      });

      const token = nextGatewayId("http-tools-token");
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const registerCountPath = path.join(tempHome, "workspace-plugin-register-count.txt");
      await writeWorkspacePlugin({
        workspaceDir,
        id: "http-probe",
        activation: { onStartup: true },
        body: `
const fs = require("node:fs");
const counterPath = ${JSON.stringify(registerCountPath)};
module.exports = {
  id: "http-probe",
  register() {
    const current = fs.existsSync(counterPath)
      ? Number.parseInt(fs.readFileSync(counterPath, "utf8").trim(), 10) || 0
      : 0;
    fs.writeFileSync(counterPath, String(current + 1), "utf8");
  },
};
`.trimStart(),
      });

      const configPath = await createGatewayConfigPath(tempHome);
      const cfg = {
        agents: {
          defaults: { workspace: workspaceDir },
          entries: { main: { default: true, tools: { allow: ["agents_list"] } } },
        },
        plugins: {
          allow: ["http-probe"],
        },
        gateway: { auth: { token } },
      };
      await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);

      const { port, server } = await startLoopbackTokenGateway(token);

      try {
        const beforeCount = await readCounterWithRetry(registerCountPath);
        expect(beforeCount).toBeGreaterThan(0);

        const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            connection: "close",
          },
          body: JSON.stringify({
            tool: "agents_list",
            action: "json",
            args: {},
            sessionKey: "main",
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);

        const afterCount = await readCounterWithRetry(registerCountPath);
        expect(afterCount).toBe(beforeCount);
      } finally {
        await server.close({ reason: "http tools workspace test complete" });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );

  it(
    "runs wizard over ws and writes auth token config",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { envSnapshot, tempHome } = await setupGatewayTempHome({
        prefix: "openclaw-wizard-home-",
        minimalGateway: true,
      });
      deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");

      const configPath = await createGatewayConfigPath(tempHome);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      clearRuntimeConfigSnapshot();
      clearConfigCache();

      const wizardToken = nextGatewayId("wiz-token");
      const port = await getFreeGatewayPort();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token: wizardToken },
        controlUiEnabled: false,
        wizardRunner: async (_opts, _runtime, prompter) => {
          await prompter.intro("Wizard E2E");
          await prompter.note("write token");
          const token = await prompter.text({ message: "token" });
          await createConfigIO({ configPath }).writeConfigFile({
            gateway: { auth: { mode: "token", token } },
          });
          await prompter.outro("ok");
        },
      });

      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: wizardToken,
        clientDisplayName: "vitest-wizard",
      });

      try {
        const start = await client.request<{
          sessionId?: string;
          done: boolean;
          status: "running" | "done" | "cancelled" | "error";
          step?: {
            id: string;
            type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress";
          };
          error?: string;
        }>("wizard.start", { mode: "local" });
        const sessionId = start.sessionId;
        expect(typeof sessionId).toBe("string");

        let next = start;
        let didSendToken = false;
        const seenSteps: string[] = [];
        while (!next.done) {
          const step = next.step;
          if (!step) {
            throw new Error("wizard missing step");
          }
          seenSteps.push(`${step.type}:${step.id}`);
          const value = step.type === "text" ? wizardToken : null;
          if (step.type === "text") {
            didSendToken = true;
          }
          next = await client.request(
            "wizard.next",
            {
              sessionId,
              answer: { stepId: step.id, value },
            },
            { timeoutMs: 60_000 },
          );
        }

        expect(didSendToken, `seenSteps=${seenSteps.join(",")} final=${JSON.stringify(next)}`).toBe(
          true,
        );
        expect(next.status).toBe("done");

        await expect
          .poll(
            async () => {
              const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
              const token = (parsed as Record<string, unknown>)?.gateway as
                | Record<string, unknown>
                | undefined;
              return (token?.auth as { token?: string } | undefined)?.token;
            },
            { timeout: 5_000 },
          )
          .toBe(wizardToken);
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "wizard e2e complete" });
      }

      const port2 = await getFreeGatewayPort();
      const server2 = await startGatewayServer(port2, {
        bind: "loopback",
        controlUiEnabled: false,
      });
      try {
        const resNoToken = await connectDeviceAuthReq({
          url: `ws://127.0.0.1:${port2}`,
        });
        expect(resNoToken.ok).toBe(false);
        expect(resNoToken.error?.message ?? "").toContain("unauthorized");

        const resToken = await connectDeviceAuthReq({
          url: `ws://127.0.0.1:${port2}`,
          token: wizardToken,
        });
        expect(resToken.ok).toBe(true);
      } finally {
        await server2.close({ reason: "wizard auth verify" });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );

  it.each([
    { flow: "setup", exitCode: 0, status: "done" },
    { flow: "setup", exitCode: 23, status: "error" },
    { flow: "channels", exitCode: 0, status: "done" },
    { flow: "channels", exitCode: 23, status: "error" },
  ] as const)(
    "keeps the authenticated Gateway alive after a $flow wizard exits $exitCode",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async ({ flow, exitCode, status }) => {
      const { envSnapshot, tempHome } = await setupGatewayTempHome({
        prefix: `openclaw-wizard-${flow}-exit-home-`,
        minimalGateway: true,
      });
      const wizardToken = nextGatewayId("wiz-contained-exit");
      const port = await getFreeGatewayPort();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token: wizardToken },
        controlUiEnabled: false,
        wizardRunner: async (_opts, runtime, prompter) => {
          await prompter.outro("wizard complete");
          runtime.exit(exitCode);
        },
        channelWizardRunner: async (_opts, runtime, prompter) => {
          await prompter.outro("channel wizard complete");
          runtime.exit(exitCode);
        },
      });
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: wizardToken,
        clientDisplayName: "vitest-wizard-contained-exit",
      });
      // Intercept an actual host exit so the fail-first Gateway test cannot
      // terminate its Vitest worker before reporting the regression.
      const processExit = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`Gateway process exit ${code}`);
      });

      try {
        const start = await client.request<{
          sessionId: string;
          done: boolean;
          status: "running" | "done" | "cancelled" | "error";
          step?: { id: string };
        }>("wizard.start", flow === "channels" ? { flow } : { mode: "local" });
        expect(start).toMatchObject({ done: false, status: "running" });
        expect(start.step?.id).toBeTruthy();

        const result = await client.request<{
          done: boolean;
          status: "running" | "done" | "cancelled" | "error";
          error?: string;
        }>("wizard.next", {
          sessionId: start.sessionId,
          answer: { stepId: start.step?.id, value: null },
        });
        expect(result).toMatchObject({ done: true, status });
        if (exitCode !== 0) {
          expect(result.error).toContain(String(exitCode));
        }
        expect(processExit).not.toHaveBeenCalled();
        await expect(client.request("health", {})).resolves.toBeDefined();
      } finally {
        processExit.mockRestore();
        await disconnectGatewayClient(client);
        await server.close({ reason: "wizard runtime isolation E2E complete" });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );

  it(
    "routes wizard.start flow channels to the channel wizard runner",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { envSnapshot, tempHome } = await setupGatewayTempHome({
        prefix: "openclaw-wizard-channels-home-",
        minimalGateway: true,
      });
      const wizAuth = nextGatewayId("wiz-chan");
      const port = await getFreeGatewayPort();
      const channelRuns: Array<string | undefined> = [];
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token: wizAuth },
        controlUiEnabled: false,
        wizardRunner: async () => {
          throw new Error("setup wizard runner must not run for flow channels");
        },
        channelWizardRunner: async (opts, _runtime, prompter) => {
          channelRuns.push(opts.channel);
          await prompter.intro("Channel setup");
          const choice = await prompter.select({
            message: "channel",
            options: [{ value: opts.channel ?? "none", label: opts.channel ?? "none" }],
          });
          opts.onConfigured?.([{ channel: choice, accountId: "default" }]);
          await prompter.outro(`configured ${choice}`);
        },
      });

      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: wizAuth,
        clientDisplayName: "vitest-wizard-channels",
      });

      try {
        const start = await client.request<{
          sessionId?: string;
          done: boolean;
          status: "running" | "done" | "cancelled" | "error";
          step?: { id: string; type: string };
          channels?: string[];
          accounts?: Array<{ channel: string; accountId: string }>;
        }>("wizard.start", { flow: "channels", channel: "telegram" });
        const sessionId = start.sessionId;
        expect(typeof sessionId).toBe("string");

        let next = start;
        const seenSteps: string[] = [];
        while (!next.done) {
          const step = next.step;
          if (!step) {
            throw new Error("wizard missing step");
          }
          seenSteps.push(step.type);
          next = await client.request(
            "wizard.next",
            {
              sessionId,
              answer: { stepId: step.id, value: step.type === "select" ? "telegram" : null },
            },
            { timeoutMs: 60_000 },
          );
        }

        expect(next.status, `seenSteps=${seenSteps.join(",")}`).toBe("done");
        expect(seenSteps).toContain("select");
        expect(channelRuns).toEqual(["telegram"]);
        expect(next.channels).toEqual(["telegram"]);
        expect(next.accounts).toEqual([{ channel: "telegram", accountId: "default" }]);
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "wizard channels flow complete" });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );

  it(
    "ignores env-driven plugin auto-enable in minimal gateway mode",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const envSnapshot = captureEnv([
        "HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_CANVAS_HOST",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
        "OPENCLAW_SKIP_PROVIDERS",
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
        "OPENCLAW_TEST_MINIMAL_GATEWAY",
        "DISCORD_BOT_TOKEN",
      ]);

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-minimal-gateway-home-"));
      const configPath = await createGatewayConfigPath(tempHome);
      const bundledPluginsDir = path.join(tempHome, "openclaw-test-no-bundled-extensions");
      setTestEnvValue("HOME", tempHome);
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempHome, ".openclaw"));
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
      setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
      setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
      setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
      setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
      setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
      setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
      setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
      setTestEnvValue("DISCORD_BOT_TOKEN", "discord-test-token");

      const token = nextGatewayId("minimal-token");
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      await fs.mkdir(bundledPluginsDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { auth: { mode: "token", token } } }, null, 2)}\n`,
      );

      const { server } = await startLoopbackTokenGateway(token);

      try {
        const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as {
          channels?: Record<string, unknown>;
          plugins?: { entries?: Record<string, { enabled?: boolean }> };
        };
        expect(parsed.plugins?.entries?.discord).toBeUndefined();
      } finally {
        await server.close({ reason: "minimal gateway auto-enable verify" });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );
});
