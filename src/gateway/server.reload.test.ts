import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import { openTrackedWs } from "./device-authz.test-helpers.js";
import { ConnectErrorDetailCodes } from "./protocol/connect-error-details.js";
import {
  connectReq,
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

const hoisted = vi.hoisted(() => {
  const cronInstances: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  class CronServiceMock {
    start = vi.fn(async () => {});
    stop = vi.fn();
    constructor() {
      cronInstances.push(this);
    }
  }

  const heartbeatStop = vi.fn();
  const heartbeatUpdateConfig = vi.fn();
  const startHeartbeatRunner = vi.fn(() => ({
    stop: heartbeatStop,
    updateConfig: heartbeatUpdateConfig,
  }));
  const activeEmbeddedRunCount = { value: 0 };
  const totalPendingReplies = { value: 0 };
  const totalQueueSize = { value: 0 };
  const activeTaskCount = { value: 0 };

  const startGmailWatcher = vi.fn(async () => ({ started: true }));
  const stopGmailWatcher = vi.fn(async () => {});

  const providerManager = {
    getRuntimeSnapshot: vi.fn(() => ({
      providers: {
        whatsapp: {
          running: false,
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastMessageAt: null,
          lastEventAt: null,
          lastError: null,
        },
        telegram: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          mode: null,
        },
        discord: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        slack: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        signal: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          baseUrl: null,
        },
        imessage: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          cliPath: null,
          dbPath: null,
        },
        msteams: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
      },
      providerAccounts: {
        whatsapp: {},
        telegram: {},
        discord: {},
        slack: {},
        signal: {},
        imessage: {},
        msteams: {},
      },
    })),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    markChannelLoggedOut: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
  };

  const createChannelManager = vi.fn(() => providerManager);

  const reloaderStop = vi.fn(async () => {});
  let onHotReload: ((plan: unknown, nextConfig: unknown) => Promise<void>) | null = null;
  let onRestart: ((plan: unknown, nextConfig: unknown) => void) | null = null;

  const startGatewayConfigReloader = vi.fn(
    (opts: { onHotReload: typeof onHotReload; onRestart: typeof onRestart }) => {
      onHotReload = opts.onHotReload;
      onRestart = opts.onRestart;
      return { stop: reloaderStop };
    },
  );

  return {
    CronService: CronServiceMock,
    cronInstances,
    heartbeatStop,
    heartbeatUpdateConfig,
    startHeartbeatRunner,
    activeEmbeddedRunCount,
    totalPendingReplies,
    totalQueueSize,
    activeTaskCount,
    startGmailWatcher,
    stopGmailWatcher,
    providerManager,
    createChannelManager,
    startGatewayConfigReloader,
    reloaderStop,
    getOnHotReload: () => onHotReload,
    getOnRestart: () => onRestart,
  };
});

vi.mock("../cron/service.js", () => ({
  CronService: hoisted.CronService,
}));

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  startGmailWatcher: hoisted.startGmailWatcher,
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("../agents/pi-embedded-runner/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/pi-embedded-runner/runs.js")>(
    "../agents/pi-embedded-runner/runs.js",
  );
  return {
    ...actual,
    getActiveEmbeddedRunCount: () => hoisted.activeEmbeddedRunCount.value,
  };
});

vi.mock("../auto-reply/reply/dispatcher-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/reply/dispatcher-registry.js")>(
    "../auto-reply/reply/dispatcher-registry.js",
  );
  return {
    ...actual,
    getTotalPendingReplies: () => hoisted.totalPendingReplies.value,
  };
});

vi.mock("../process/command-queue.js", async () => {
  const actual = await vi.importActual<typeof import("../process/command-queue.js")>(
    "../process/command-queue.js",
  );
  return {
    ...actual,
    getTotalQueueSize: () => hoisted.totalQueueSize.value,
  };
});

vi.mock("../tasks/task-registry.maintenance.js", async () => {
  const actual = await vi.importActual<typeof import("../tasks/task-registry.maintenance.js")>(
    "../tasks/task-registry.maintenance.js",
  );
  return {
    ...actual,
    getInspectableTaskRegistrySummary: () => ({
      active: hoisted.activeTaskCount.value,
      queued: 0,
      completed: 0,
      failed: 0,
    }),
  };
});

vi.mock("./server-channels.js", () => ({
  createChannelManager: hoisted.createChannelManager,
}));

vi.mock("./config-reload.js", () => ({
  startGatewayConfigReloader: hoisted.startGatewayConfigReloader,
}));

installGatewayTestHooks({ scope: "suite" });

async function waitForGatewayAuthChangedClose(ws: WebSocket): Promise<{
  code: number;
  reason: string;
}> {
  return await new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe("gateway hot reload", () => {
  let prevSkipChannels: string | undefined;
  let prevSkipGmail: string | undefined;
  let prevSkipProviders: string | undefined;
  let prevOpenAiApiKey: string | undefined;

  beforeEach(() => {
    prevSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    prevSkipGmail = process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    prevSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENCLAW_SKIP_CHANNELS = "0";
    delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    hoisted.activeEmbeddedRunCount.value = 0;
    hoisted.totalPendingReplies.value = 0;
    hoisted.totalQueueSize.value = 0;
    hoisted.activeTaskCount.value = 0;
  });

  afterEach(() => {
    if (prevSkipChannels === undefined) {
      delete process.env.OPENCLAW_SKIP_CHANNELS;
    } else {
      process.env.OPENCLAW_SKIP_CHANNELS = prevSkipChannels;
    }
    if (prevSkipGmail === undefined) {
      delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    } else {
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = prevSkipGmail;
    }
    if (prevSkipProviders === undefined) {
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
    } else {
      process.env.OPENCLAW_SKIP_PROVIDERS = prevSkipProviders;
    }
    if (prevOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevOpenAiApiKey;
    }
  });

  async function writeEnvRefConfig() {
    await writeConfigFile({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    });
  }

  async function writeConfigFile(config: unknown) {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  const testNodeExecProvider = {
    source: "exec" as const,
    command: process.execPath,
    // CI-hosted Node binaries can be group-writable; these cases cover reload semantics.
    allowInsecurePath: true,
  };

  async function writeTalkProviderApiKeyEnvRefConfig(refId = "TALK_API_KEY_REF") {
    await writeConfigFile({
      talk: {
        providers: {
          [TALK_TEST_PROVIDER_ID]: {
            apiKey: { source: "env", provider: "default", id: refId },
          },
        },
      },
    });
  }

  async function writeGatewayTokenExecRefConfig(params: {
    resolverScriptPath: string;
    modePath: string;
    tokenValue: string;
  }) {
    await writeConfigFile({
      gateway: {
        auth: {
          mode: "token",
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      },
      secrets: {
        providers: {
          vault: {
            ...testNodeExecProvider,
            allowSymlinkCommand: true,
            args: [params.resolverScriptPath, params.modePath, params.tokenValue],
          },
        },
      },
    });
  }

  async function expectOneShotSecretReloadEvents(params: {
    applyReload: () => Promise<unknown> | undefined;
    sessionKey: string;
    expectedError: RegExp | string;
  }) {
    await expect(params.applyReload()).rejects.toThrow(params.expectedError);
    const degradedEvents = drainSystemEvents(params.sessionKey);
    expect(degradedEvents.some((event) => event.includes("[SECRETS_RELOADER_DEGRADED]"))).toBe(
      true,
    );

    await expect(params.applyReload()).rejects.toThrow(params.expectedError);
    expect(drainSystemEvents(params.sessionKey)).toEqual([]);
  }

  async function expectSecretReloadRecovered(params: {
    applyReload: () => Promise<unknown> | undefined;
    sessionKey: string;
  }) {
    await expect(params.applyReload()).resolves.toBeUndefined();
    const recoveredEvents = drainSystemEvents(params.sessionKey);
    expect(recoveredEvents.some((event) => event.includes("[SECRETS_RELOADER_RECOVERED]"))).toBe(
      true,
    );
  }

  async function withNonMinimalGatewayServer(
    fn: Parameters<typeof withGatewayServer>[0],
  ): ReturnType<typeof withGatewayServer> {
    return await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: undefined }, async () =>
      withGatewayServer(fn),
    );
  }

  it("applies hot reload actions and emits restart signal", async () => {
    await withNonMinimalGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");

      const nextConfig = {
        hooks: {
          enabled: true,
          token: "secret",
          gmail: { account: "me@example.com" },
        },
        cron: { enabled: true, store: "/tmp/cron.json" },
        agents: { defaults: { heartbeat: { every: "1m" }, maxConcurrent: 2 } },
        web: { enabled: true },
        channels: {
          telegram: { botToken: "token" },
          discord: { token: "token" },
          signal: { account: "+15550000000" },
          imessage: { enabled: true },
        },
      };

      await onHotReload?.(
        {
          changedPaths: [
            "hooks.gmail.account",
            "cron.enabled",
            "agents.defaults.heartbeat.every",
            "web.enabled",
            "channels.telegram.botToken",
            "channels.discord.token",
            "channels.signal.account",
            "channels.imessage.enabled",
          ],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["web.enabled"],
          reloadHooks: true,
          restartGmailWatcher: true,
          restartCron: true,
          restartHeartbeat: true,
          restartChannels: new Set(["whatsapp", "telegram", "discord", "signal", "imessage"]),
          noopPaths: [],
        },
        nextConfig,
      );

      expect(hoisted.stopGmailWatcher).toHaveBeenCalled();
      expect(hoisted.startGmailWatcher).toHaveBeenCalledWith(expect.objectContaining(nextConfig));

      expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
      expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledTimes(1);
      expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledWith(
        expect.objectContaining(nextConfig),
      );

      expect(hoisted.cronInstances.length).toBe(2);
      expect(hoisted.cronInstances[0].stop).toHaveBeenCalledTimes(1);
      expect(hoisted.cronInstances[1].start).toHaveBeenCalledTimes(1);

      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledTimes(5);
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledTimes(5);
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("whatsapp");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("whatsapp");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("telegram");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("telegram");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("discord");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("discord");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("signal");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("signal");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("imessage");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("imessage");

      const onRestart = hoisted.getOnRestart();
      expect(onRestart).toBeTypeOf("function");

      const signalSpy = vi.fn();
      process.once("SIGUSR1", signalSpy);

      const restartResult = onRestart?.(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartChannels: new Set(),
          noopPaths: [],
        },
        {},
      );
      await Promise.resolve(restartResult);

      expect(signalSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("emits one-shot degraded and recovered system events during secret reload transitions", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup"; // pragma: allowlist secret

    await withNonMinimalGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");
      const sessionKey = resolveMainSessionKeyFromConfig();
      const plan = {
        changedPaths: ["models.providers.openai.apiKey"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["models.providers.openai.apiKey"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartChannels: new Set(),
        noopPaths: [],
      };
      const nextConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      };

      delete process.env.OPENAI_API_KEY;
      await expectOneShotSecretReloadEvents({
        applyReload: () => onHotReload?.(plan, nextConfig),
        sessionKey,
        expectedError: 'Environment variable "OPENAI_API_KEY" is missing or empty.',
      });

      process.env.OPENAI_API_KEY = "sk-recovered"; // pragma: allowlist secret
      await expectSecretReloadRecovered({
        applyReload: () => onHotReload?.(plan, nextConfig),
        sessionKey,
      });
    });
  });

  it("serves secrets.reload immediately after startup without race failures", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup"; // pragma: allowlist secret
    const { server, ws } = await startServerWithClient();
    try {
      await connectOk(ws);
      const [first, second] = await Promise.all([
        rpcReq<{ warningCount: number }>(ws, "secrets.reload", {}),
        rpcReq<{ warningCount: number }>(ws, "secrets.reload", {}),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it("keeps last-known-good snapshot active when secrets.reload fails over RPC", async () => {
    const refId = "RUNTIME_LKG_TALK_API_KEY";
    const previousRefValue = process.env[refId];
    process.env[refId] = "talk-key-before-reload-failure"; // pragma: allowlist secret
    await writeTalkProviderApiKeyEnvRefConfig(refId);

    const { server, ws } = await startServerWithClient();
    try {
      await connectOk(ws);
      const preResolve = await rpcReq<{
        assignments?: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      }>(ws, "secrets.resolve", {
        commandName: "runtime-lkg-test",
        targetIds: ["talk.providers.*.apiKey"],
      });
      expect(preResolve.ok).toBe(true);
      expect(preResolve.payload?.assignments?.[0]?.path).toBe(TALK_TEST_PROVIDER_API_KEY_PATH);
      expect(preResolve.payload?.assignments?.[0]?.value).toBe("talk-key-before-reload-failure");

      delete process.env[refId];
      const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {});
      expect(reload.ok).toBe(false);
      expect(reload.error?.code).toBe("UNAVAILABLE");
      expect(reload.error?.message ?? "").toContain(refId);

      const postResolve = await rpcReq<{
        assignments?: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      }>(ws, "secrets.resolve", {
        commandName: "runtime-lkg-test",
        targetIds: ["talk.providers.*.apiKey"],
      });
      expect(postResolve.ok).toBe(true);
      expect(postResolve.payload?.assignments?.[0]?.path).toBe(TALK_TEST_PROVIDER_API_KEY_PATH);
      expect(postResolve.payload?.assignments?.[0]?.value).toBe("talk-key-before-reload-failure");
    } finally {
      if (previousRefValue === undefined) {
        delete process.env[refId];
      } else {
        process.env[refId] = previousRefValue;
      }
      ws.close();
      await server.close();
    }
  });

  it("keeps last-known-good auth snapshot active when gateway auth token exec reload fails", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is not set");
    }
    const resolverScriptPath = path.join(stateDir, "gateway-auth-token-resolver.cjs");
    const modePath = path.join(stateDir, "gateway-auth-token-resolver.mode");
    const tokenValue = "gateway-auth-exec-token";
    await fs.mkdir(path.dirname(resolverScriptPath), { recursive: true });
    await fs.writeFile(
      resolverScriptPath,
      `const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const modePath = process.argv[2];
  const token = process.argv[3];
  const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8").trim() : "ok";
  let ids = ["gateway/token"];
  try {
    const parsed = JSON.parse(input || "{}");
    if (Array.isArray(parsed.ids) && parsed.ids.length > 0) {
      ids = parsed.ids.map((entry) => String(entry));
    }
  } catch {}

  if (mode === "fail") {
    const errors = {};
    for (const id of ids) {
      errors[id] = { message: "forced failure" };
    }
    process.stdout.write(JSON.stringify({ protocolVersion: 1, values: {}, errors }) + "\\n");
    return;
  }

  const values = {};
  for (const id of ids) {
    values[id] = token;
  }
  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }) + "\\n");
});
`,
      "utf8",
    );
    await fs.writeFile(modePath, "ok\n", "utf8");
    await writeGatewayTokenExecRefConfig({
      resolverScriptPath,
      modePath,
      tokenValue,
    });

    const previousGatewayAuth = testState.gatewayAuth;
    const previousGatewayTokenEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
    try {
      testState.gatewayAuth = undefined;
      delete process.env.OPENCLAW_GATEWAY_TOKEN;

      started = await startServerWithClient();
      const { ws } = started;
      await connectOk(ws, {
        token: tokenValue,
      });
      const preResolve = await rpcReq<{
        assignments?: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      }>(ws, "secrets.resolve", {
        commandName: "runtime-lkg-auth-test",
        targetIds: ["gateway.auth.token"],
      });
      expect(preResolve.ok).toBe(true);
      expect(preResolve.payload?.assignments?.[0]?.path).toBe("gateway.auth.token");
      expect(preResolve.payload?.assignments?.[0]?.value).toBe(tokenValue);

      await fs.writeFile(modePath, "fail\n", "utf8");
      const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {});
      expect(reload.ok).toBe(false);
      expect(reload.error?.code).toBe("UNAVAILABLE");
      expect(reload.error?.message ?? "").toContain("forced failure");

      const postResolve = await rpcReq<{
        assignments?: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      }>(ws, "secrets.resolve", {
        commandName: "runtime-lkg-auth-test",
        targetIds: ["gateway.auth.token"],
      });
      expect(postResolve.ok).toBe(true);
      expect(postResolve.payload?.assignments?.[0]?.path).toBe("gateway.auth.token");
      expect(postResolve.payload?.assignments?.[0]?.value).toBe(tokenValue);
    } finally {
      testState.gatewayAuth = previousGatewayAuth;
      if (previousGatewayTokenEnv === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayTokenEnv;
      }
      started?.envSnapshot.restore();
      started?.ws.close();
      await started?.server.close();
    }
  });

  it("uses refreshed gateway auth for new websocket connects after secrets reload", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is not set");
    }
    const resolverScriptPath = path.join(stateDir, "gateway-auth-refresh-resolver.cjs");
    const tokenPath = path.join(stateDir, "gateway-auth-refresh-token.txt");
    await fs.mkdir(path.dirname(resolverScriptPath), { recursive: true });
    await fs.writeFile(
      resolverScriptPath,
      `const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const tokenPath = process.argv[2];
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  let ids = ["gateway/token"];
  try {
    const parsed = JSON.parse(input || "{}");
    if (Array.isArray(parsed.ids) && parsed.ids.length > 0) {
      ids = parsed.ids.map((entry) => String(entry));
    }
  } catch {}

  const values = {};
  for (const id of ids) {
    values[id] = token;
  }
  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }) + "\\n");
});
`,
      "utf8",
    );
    await fs.writeFile(tokenPath, "token-before-reload\n", "utf8");
    await writeConfigFile({
      gateway: {
        auth: {
          mode: "token",
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      },
      secrets: {
        providers: {
          vault: {
            ...testNodeExecProvider,
            allowSymlinkCommand: true,
            args: [resolverScriptPath, tokenPath],
          },
        },
      },
    });

    const previousGatewayAuth = testState.gatewayAuth;
    const previousGatewayTokenEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
    try {
      testState.gatewayAuth = undefined;
      delete process.env.OPENCLAW_GATEWAY_TOKEN;

      started = await startServerWithClient();
      const { ws, port } = started;
      await connectOk(ws, { token: "token-before-reload" });

      await fs.writeFile(tokenPath, "token-after-reload\n", "utf8");
      const closed = waitForGatewayAuthChangedClose(ws);
      const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {}).catch(
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      );
      await expect(closed).resolves.toEqual({
        code: 4001,
        reason: "gateway auth changed",
      });
      if (!(reload instanceof Error)) {
        expect(reload.ok).toBe(true);
      }

      const staleWs = await openTrackedWs(port);
      try {
        const staleConnect = await connectReq(staleWs, {
          token: "token-before-reload",
          skipDefaultAuth: true,
        });
        expect(staleConnect.ok).toBe(false);
        expect(staleConnect.error?.message ?? "").toContain("gateway token mismatch");
        expect((staleConnect.error?.details as { code?: unknown } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
        );
      } finally {
        staleWs.close();
      }

      const freshWs = await openTrackedWs(port);
      try {
        await connectOk(freshWs, {
          token: "token-after-reload",
          skipDefaultAuth: true,
        });
      } finally {
        freshWs.close();
      }
    } finally {
      testState.gatewayAuth = previousGatewayAuth;
      if (previousGatewayTokenEnv === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayTokenEnv;
      }
      started?.envSnapshot.restore();
      started?.ws.close();
      await started?.server.close();
    }
  });
});

describe("gateway agents", () => {
  it("lists configured agents via agents.list RPC", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);
    const res = await rpcReq<{ agents: Array<{ id: string }> }>(ws, "agents.list", {});
    expect(res.ok).toBe(true);
    expect(res.payload?.agents.map((agent) => agent.id)).toContain("main");
    ws.close();
    await server.close();
  });
});
