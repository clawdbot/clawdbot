import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

export type BridgeClientInfo = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
};

export type BridgeStartOpts = {
  onAuthenticated?: (node: BridgeClientInfo) => Promise<void> | void;
  onDisconnected?: (node: BridgeClientInfo) => Promise<void> | void;
  onPairRequested?: (request: unknown) => Promise<void> | void;
  onEvent?: (
    nodeId: string,
    evt: { event: string; payloadJSON?: string | null },
  ) => Promise<void> | void;
  onRequest?: (
    nodeId: string,
    req: { id: string; method: string; paramsJSON?: string | null },
  ) => Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  >;
};

const hoisted = vi.hoisted(() => ({
  bridgeStartCalls: [] as BridgeStartOpts[],
  bridgeInvoke: vi.fn(async () => ({
    type: "invoke-res",
    id: "1",
    ok: true,
    payloadJSON: JSON.stringify({ ok: true }),
    error: null,
  })),
  bridgeListConnected: vi.fn(() => [] as BridgeClientInfo[]),
  bridgeSendEvent: vi.fn(),
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
}));

const testConfigRoot = {
  value: path.join(os.tmpdir(), `clawdbot-gateway-test-${process.pid}-${crypto.randomUUID()}`),
};

export const setTestConfigRoot = (root: string) => {
  testConfigRoot.value = root;
};

export const bridgeStartCalls = hoisted.bridgeStartCalls;
export const bridgeInvoke = hoisted.bridgeInvoke;
export const bridgeListConnected = hoisted.bridgeListConnected;
export const bridgeSendEvent = hoisted.bridgeSendEvent;
export const testTailnetIPv4 = hoisted.testTailnetIPv4;
export const piSdkMock = hoisted.piSdkMock;
export const cronIsolatedRun = hoisted.cronIsolatedRun;
export const agentCommand = hoisted.agentCommand;

export const testState = {
  agentConfig: undefined as Record<string, unknown> | undefined,
  agentsConfig: undefined as Record<string, unknown> | undefined,
  bindingsConfig: undefined as Array<Record<string, unknown>> | undefined,
  sessionStorePath: undefined as string | undefined,
  sessionConfig: undefined as Record<string, unknown> | undefined,
  allowFrom: undefined as string[] | undefined,
  cronStorePath: undefined as string | undefined,
  cronEnabled: false as boolean | undefined,
  gatewayBind: undefined as "auto" | "lan" | "tailnet" | "loopback" | undefined,
  gatewayAuth: undefined as Record<string, unknown> | undefined,
  hooksConfig: undefined as Record<string, unknown> | undefined,
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

vi.mock("../infra/bridge/server.js", () => ({
  startNodeBridgeServer: vi.fn(async (opts: BridgeStartOpts) => {
    bridgeStartCalls.push(opts);
    return {
      port: 18790,
      close: async () => {},
      listConnected: bridgeListConnected,
      invoke: bridgeInvoke,
      sendEvent: bridgeSendEvent,
    };
  }),
}));

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
  const resolveConfigPath = () => path.join(testConfigRoot.value, "clawdbot.json");
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
    get CONFIG_PATH_CLAWDBOT() {
      return resolveConfigPath();
    },
    get STATE_DIR_CLAWDBOT() {
      return path.dirname(resolveConfigPath());
    },
    get isNixMode() {
      return testIsNixMode.value;
    },
    migrateLegacyConfig: (raw: unknown) => ({
      config: testState.migrationConfig ?? (raw as Record<string, unknown>),
      changes: testState.migrationChanges,
    }),
    loadConfig: () => ({
      agents: (() => {
        const defaults = {
          model: "anthropic/claude-opus-4-5",
          workspace: path.join(os.tmpdir(), "clawd-gateway-test"),
          ...testState.agentConfig,
        };
        if (testState.agentsConfig) {
          return { ...testState.agentsConfig, defaults };
        }
        return { defaults };
      })(),
      bindings: testState.bindingsConfig,
      channels: {
        whatsapp: {
          allowFrom: testState.allowFrom,
        },
      },
      session: {
        mainKey: "main",
        store: testState.sessionStorePath,
        ...testState.sessionConfig,
      },
      gateway: (() => {
        const gateway: Record<string, unknown> = {};
        if (testState.gatewayBind) gateway.bind = testState.gatewayBind;
        if (testState.gatewayAuth) gateway.auth = testState.gatewayAuth;
        return Object.keys(gateway).length > 0 ? gateway : undefined;
      })(),
      canvasHost: (() => {
        const canvasHost: Record<string, unknown> = {};
        if (typeof testState.canvasHostPort === "number")
          canvasHost.port = testState.canvasHostPort;
        return Object.keys(canvasHost).length > 0 ? canvasHost : undefined;
      })(),
      hooks: testState.hooksConfig,
      cron: (() => {
        const cron: Record<string, unknown> = {};
        if (typeof testState.cronEnabled === "boolean") cron.enabled = testState.cronEnabled;
        if (typeof testState.cronStorePath === "string") cron.store = testState.cronStorePath;
        return Object.keys(cron).length > 0 ? cron : undefined;
      })(),
    }),
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
  sendMessageWhatsApp: vi.fn().mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand,
}));

process.env.CLAWDBOT_SKIP_CHANNELS = "1";
