import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

import type { ChannelPlugin, ChannelOutboundAdapter } from "../channels/plugins/types.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { AgentBinding } from "../config/types.agents.js";
import type { HooksConfig } from "../config/types.hooks.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type StubChannelOptions = {
  id: ChannelPlugin["id"];
  label: string;
  summary?: Record<string, unknown>;
};

const createStubOutboundAdapter = (channelId: ChannelPlugin["id"]): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendText: async () => ({
    channel: channelId,
    messageId: `${channelId}-msg`,
  }),
  sendMedia: async () => ({
    channel: channelId,
    messageId: `${channelId}-msg`,
  }),
});

const createStubChannelPlugin = (params: StubChannelOptions): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label,
    selectionLabel: params.label,
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => ({}),
    isConfigured: async () => false,
  },
  status: {
    buildChannelSummary: async () => ({
      configured: false,
      ...(params.summary ? params.summary : {}),
    }),
  },
  outbound: createStubOutboundAdapter(params.id),
  messaging: {
    normalizeTarget: (raw) => raw,
  },
  gateway: {
    logoutAccount: async () => ({
      cleared: false,
      envToken: false,
      loggedOut: false,
    }),
  },
});

const createStubPluginRegistry = (): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [
    {
      pluginId: "whatsapp",
      source: "test",
      plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
    },
    {
      pluginId: "telegram",
      source: "test",
      plugin: createStubChannelPlugin({
        id: "telegram",
        label: "Telegram",
        summary: { tokenSource: "none", lastProbeAt: null },
      }),
    },
    {
      pluginId: "discord",
      source: "test",
      plugin: createStubChannelPlugin({ id: "discord", label: "Discord" }),
    },
    {
      pluginId: "slack",
      source: "test",
      plugin: createStubChannelPlugin({ id: "slack", label: "Slack" }),
    },
    {
      pluginId: "signal",
      source: "test",
      plugin: createStubChannelPlugin({
        id: "signal",
        label: "Signal",
        summary: { lastProbeAt: null },
      }),
    },
    {
      pluginId: "imessage",
      source: "test",
      plugin: createStubChannelPlugin({ id: "imessage", label: "iMessage" }),
    },
    {
      pluginId: "msteams",
      source: "test",
      plugin: createStubChannelPlugin({ id: "msteams", label: "Microsoft Teams" }),
    },
    {
      pluginId: "matrix",
      source: "test",
      plugin: createStubChannelPlugin({ id: "matrix", label: "Matrix" }),
    },
    {
      pluginId: "zalo",
      source: "test",
      plugin: createStubChannelPlugin({ id: "zalo", label: "Zalo" }),
    },
    {
      pluginId: "zalouser",
      source: "test",
      plugin: createStubChannelPlugin({ id: "zalouser", label: "Zalo Personal" }),
    },
    {
      pluginId: "bluebubbles",
      source: "test",
      plugin: createStubChannelPlugin({ id: "bluebubbles", label: "BlueBubbles" }),
    },
  ],
  providers: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  diagnostics: [],
});

const hoisted = vi.hoisted(() => ({
  testTailnetIPv4: { value: undefined as string | undefined },
  piSdkMock: {
    enabled: false,
    discoverCalls: 0,
    models: [] as Array<{
      id: string;
      name?: string;
      provider: string;
      contextWindow?: number;
      reasoning?: boolean;
    }>,
  },
  cronIsolatedRun: vi.fn(async () => ({ status: "ok", summary: "ok" })),
  agentCommand: vi.fn().mockResolvedValue(undefined),
  testIsNixMode: { value: false },
  sessionStoreSaveDelayMs: { value: 0 },
  embeddedRunMock: {
    activeIds: new Set<string>(),
    abortCalls: [] as string[],
    waitCalls: [] as string[],
    waitResults: new Map<string, boolean>(),
  },
  getReplyFromConfig: vi.fn().mockResolvedValue(undefined),
  sendWhatsAppMock: vi.fn().mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
}));

const pluginRegistryState = {
  registry: createStubPluginRegistry(),
};
setActivePluginRegistry(pluginRegistryState.registry);

export const setTestPluginRegistry = (registry: PluginRegistry) => {
  pluginRegistryState.registry = registry;
  setActivePluginRegistry(registry);
};

export const resetTestPluginRegistry = () => {
  pluginRegistryState.registry = createStubPluginRegistry();
  setActivePluginRegistry(pluginRegistryState.registry);
};

const testConfigRoot = {
  value: path.join(os.tmpdir(), `moltbot-gateway-test-${process.pid}-${crypto.randomUUID()}`),
};

export const setTestConfigRoot = (root: string) => {
  testConfigRoot.value = root;
  process.env.CLAWDBOT_CONFIG_PATH = path.join(root, "moltbot.json");
};

export const testTailnetIPv4 = hoisted.testTailnetIPv4;
export const piSdkMock = hoisted.piSdkMock;
export const cronIsolatedRun = hoisted.cronIsolatedRun;
export const agentCommand = hoisted.agentCommand;
export const getReplyFromConfig = hoisted.getReplyFromConfig;

export const testState = {
  agentConfig: undefined as Record<string, unknown> | undefined,
  agentsConfig: undefined as Record<string, unknown> | undefined,
  bindingsConfig: undefined as AgentBinding[] | undefined,
  channelsConfig: undefined as Record<string, unknown> | undefined,
  sessionStorePath: undefined as string | undefined,
  sessionConfig: undefined as Record<string, unknown> | undefined,
  allowFrom: undefined as string[] | undefined,
  cronStorePath: undefined as string | undefined,
  cronEnabled: false as boolean | undefined,
  gatewayBind: undefined as "auto" | "lan" | "tailnet" | "loopback" | undefined,
  gatewayAuth: undefined as Record<string, unknown> | undefined,
  gatewayControlUi: undefined as Record<string, unknown> | undefined,
  hooksConfig: undefined as HooksConfig | undefined,
  canvasHostPort: undefined as number | undefined,
  legacyIssues: [] as Array<{ path: string; message: string }>,
  legacyParsed: {} as Record<string, unknown>,
  migrationConfig: null as Record<string, unknown> | null,
  migrationChanges: [] as string[],
};

export const testIsNixMode = hoisted.testIsNixMode;
export const sessionStoreSaveDelayMs = hoisted.sessionStoreSaveDelayMs;
export const embeddedRunMock = hoisted.embeddedRunMock;

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );

  return {
    ...actual,
    discoverModels: (...args: unknown[]) => {
      if (!piSdkMock.enabled) {
        return (actual.discoverModels as (...args: unknown[]) => unknown)(...args);
      }
      piSdkMock.discoverCalls += 1;
      return piSdkMock.models;
    },
  };
});

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: (...args: unknown[]) =>
    (cronIsolatedRun as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => testTailnetIPv4.value,
  pickPrimaryTailnetIPv6: () => undefined,
}));

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    saveSessionStore: vi.fn(async (storePath: string, store: unknown) => {
      const delay = sessionStoreSaveDelayMs.value;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return actual.saveSessionStore(storePath, store as never);
    }),
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const resolveConfigPath = () => path.join(testConfigRoot.value, "moltbot.json");
  const hashConfigRaw = (raw: string | null) =>
    crypto
      .createHash("sha256")
      .update(raw ?? "")
      .digest("hex");

  const readConfigFileSnapshot = async () => {
    if (testState.legacyIssues.length > 0) {
      const raw = JSON.stringify(testState.legacyParsed ?? {});
      return {
        path: resolveConfigPath(),
        exists: true,
        raw,
        parsed: testState.legacyParsed ?? {},
        valid: false,
        config: {},
        hash: hashConfigRaw(raw),
        issues: testState.legacyIssues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
        legacyIssues: testState.legacyIssues,
      };
    }
    const configPath = resolveConfigPath();
    try {
      await fs.access(configPath);
    } catch {
      return {
        path: configPath,
        exists: false,
        raw: null,
        parsed: {},
        valid: true,
        config: {},
        hash: hashConfigRaw(null),
        issues: [],
        legacyIssues: [],
      };
    }
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        path: configPath,
        exists: true,
        raw,
        parsed,
        valid: true,
        config: parsed,
        hash: hashConfigRaw(raw),
        issues: [],
        legacyIssues: [],
      };
    } catch (err) {
      return {
        path: configPath,
        exists: true,
        raw: null,
        parsed: {},
        valid: false,
        config: {},
        hash: hashConfigRaw(null),
        issues: [{ path: "", message: `read failed: ${String(err)}` }],
        legacyIssues: [],
      };
    }
  };

  const writeConfigFile = vi.fn(async (cfg: Record<string, unknown>) => {
    const configPath = resolveConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const raw = JSON.stringify(cfg, null, 2).trimEnd().concat("\n");
    await fs.writeFile(configPath, raw, "utf-8");
  });

  return {
    ...actual,
    get CONFIG_PATH() {
      return resolveConfigPath();
    },
    get STATE_DIR() {
      return path.dirname(resolveConfigPath());
    },
    get isNixMode() {
      return testIsNixMode.value;
    },
    migrateLegacyConfig: (raw: unknown) => ({
      config: testState.migrationConfig ?? (raw as Record<string, unknown>),
      changes: testState.migrationChanges,
    }),
    loadConfig: () => {
      const configPath = resolveConfigPath();
      let fileConfig: Record<string, unknown> = {};
      try {
        if (fsSync.existsSync(configPath)) {
          const raw = fsSync.readFileSync(configPath, "utf-8");
          fileConfig = JSON.parse(raw) as Record<string, unknown>;
        }
      } catch {
        fileConfig = {};
      }

      const fileAgents =
        fileConfig.agents &&
        typeof fileConfig.agents === "object" &&
        !Array.isArray(fileConfig.agents)
          ? (fileConfig.agents as Record<string, unknown>)
          : {};
      const fileDefaults =
        fileAgents.defaults &&
        typeof fileAgents.defaults === "object" &&
        !Array.isArray(fileAgents.defaults)
          ? (fileAgents.defaults as Record<string, unknown>)
          : {};
      const defaults = {
        model: { primary: "anthropic/claude-opus-4-5" },
        workspace: path.join(os.tmpdir(), "clawd-gateway-test"),
        ...fileDefaults,
        ...testState.agentConfig,
      };
      const agents = testState.agentsConfig
        ? { ...fileAgents, ...testState.agentsConfig, defaults }
        : { ...fileAgents, defaults };

      const fileBindings = Array.isArray(fileConfig.bindings)
        ? (fileConfig.bindings as AgentBinding[])
        : undefined;

      const fileChannels =
        fileConfig.channels &&
        typeof fileConfig.channels === "object" &&
        !Array.isArray(fileConfig.channels)
          ? ({ ...(fileConfig.channels as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      const overrideChannels =
        testState.channelsConfig && typeof testState.channelsConfig === "object"
          ? { ...(testState.channelsConfig as Record<string, unknown>) }
          : {};
      const mergedChannels = { ...fileChannels, ...overrideChannels };
      if (testState.allowFrom !== undefined) {
        const existing =
          mergedChannels.whatsapp &&
          typeof mergedChannels.whatsapp === "object" &&
          !Array.isArray(mergedChannels.whatsapp)
            ? (mergedChannels.whatsapp as Record<string, unknown>)
            : {};
        mergedChannels.whatsapp = {
          ...existing,
          allowFrom: testState.allowFrom,
        };
      }
      const channels = Object.keys(mergedChannels).length > 0 ? mergedChannels : undefined;

      const fileSession =
        fileConfig.session &&
        typeof fileConfig.session === "object" &&
        !Array.isArray(fileConfig.session)
          ? (fileConfig.session as Record<string, unknown>)
          : {};
      const session: Record<string, unknown> = {
        ...fileSession,
        mainKey: fileSession.mainKey ?? "main",
      };
      if (typeof testState.sessionStorePath === "string")
        session.store = testState.sessionStorePath;
      if (testState.sessionConfig) Object.assign(session, testState.sessionConfig);

      const fileGateway =
        fileConfig.gateway &&
        typeof fileConfig.gateway === "object" &&
        !Array.isArray(fileConfig.gateway)
          ? ({ ...(fileConfig.gateway as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      if (testState.gatewayBind) fileGateway.bind = testState.gatewayBind;
      if (testState.gatewayAuth) fileGateway.auth = testState.gatewayAuth;
      if (testState.gatewayControlUi) fileGateway.controlUi = testState.gatewayControlUi;
      const gateway = Object.keys(fileGateway).length > 0 ? fileGateway : undefined;

      const fileCanvasHost =
        fileConfig.canvasHost &&
        typeof fileConfig.canvasHost === "object" &&
        !Array.isArray(fileConfig.canvasHost)
          ? ({ ...(fileConfig.canvasHost as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      if (typeof testState.canvasHostPort === "number")
        fileCanvasHost.port = testState.canvasHostPort;
      const canvasHost = Object.keys(fileCanvasHost).length > 0 ? fileCanvasHost : undefined;

      const hooks = testState.hooksConfig ?? (fileConfig.hooks as HooksConfig | undefined);

      const fileCron =
        fileConfig.cron && typeof fileConfig.cron === "object" && !Array.isArray(fileConfig.cron)
          ? ({ ...(fileConfig.cron as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      if (typeof testState.cronEnabled === "boolean") fileCron.enabled = testState.cronEnabled;
      if (typeof testState.cronStorePath === "string") fileCron.store = testState.cronStorePath;
      const cron = Object.keys(fileCron).length > 0 ? fileCron : undefined;

      const config = {
        ...fileConfig,
        agents,
        bindings: testState.bindingsConfig ?? fileBindings,
        channels,
        session,
        gateway,
        canvasHost,
        hooks,
        cron,
      };
      return applyPluginAutoEnable({ config, env: process.env }).config;
    },
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) as unknown };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    validateConfigObject: (parsed: unknown) => ({
      ok: true,
      config: parsed as Record<string, unknown>,
      issues: [],
    }),
    readConfigFileSnapshot,
    writeConfigFile,
  };
});

vi.mock("../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/pi-embedded.js")>(
    "../agents/pi-embedded.js",
  );
  return {
    ...actual,
    isEmbeddedPiRunActive: (sessionId: string) => embeddedRunMock.activeIds.has(sessionId),
    abortEmbeddedPiRun: (sessionId: string) => {
      embeddedRunMock.abortCalls.push(sessionId);
      return embeddedRunMock.activeIds.has(sessionId);
    },
    waitForEmbeddedPiRunEnd: async (sessionId: string) => {
      embeddedRunMock.waitCalls.push(sessionId);
      return embeddedRunMock.waitResults.get(sessionId) ?? true;
    },
  };
});

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../web/outbound.js", () => ({
  sendMessageWhatsApp: (...args: unknown[]) =>
    (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
  sendPollWhatsApp: (...args: unknown[]) =>
    (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));
vi.mock("../channels/web/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/web/index.js")>(
    "../channels/web/index.js",
  );
  return {
    ...actual,
    sendMessageWhatsApp: (...args: unknown[]) =>
      (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
  };
});
vi.mock("../commands/agent.js", () => ({
  agentCommand,
}));
vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig,
}));
vi.mock("../cli/deps.js", async () => {
  const actual = await vi.importActual<typeof import("../cli/deps.js")>("../cli/deps.js");
  const base = actual.createDefaultDeps();
  return {
    ...actual,
    createDefaultDeps: () => ({
      ...base,
      sendMessageWhatsApp: (...args: unknown[]) =>
        (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
    }),
  };
});

process.env.CLAWDBOT_SKIP_CHANNELS = "1";
process.env.CLAWDBOT_SKIP_CRON = "1";
