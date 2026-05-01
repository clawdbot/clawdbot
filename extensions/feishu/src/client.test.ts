import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import type { ResolvedFeishuAccount } from "./types.js";

type CreateFeishuClient = typeof import("./client.js").createFeishuClient;
type CreateFeishuWSClient = typeof import("./client.js").createFeishuWSClient;
type ClearClientCache = typeof import("./client.js").clearClientCache;
type SetFeishuClientRuntimeForTest = typeof import("./client.js").setFeishuClientRuntimeForTest;

const clientCtorMock = vi.hoisted(() =>
  vi.fn(function clientCtor() {
    return { connected: true };
  }),
);
const wsClientCtorMock = vi.hoisted(() =>
  vi.fn(function wsClientCtor() {
    return { connected: true };
  }),
);
const proxyAgentCtorMock = vi.hoisted(() =>
  vi.fn(function proxyAgentCtor() {
    return { proxied: true };
  }),
);
const mockBaseHttpInstance = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue({}),
  post: vi.fn().mockResolvedValue({}),
  put: vi.fn().mockResolvedValue({}),
  patch: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  head: vi.fn().mockResolvedValue({}),
  options: vi.fn().mockResolvedValue({}),
}));
const proxyEnvKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
type ProxyEnvKey = (typeof proxyEnvKeys)[number];
const registerFeishuDocToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuChatToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuWikiToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuDriveToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuPermToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuBitableToolsMock = vi.hoisted(() => vi.fn());
const feishuPluginMock = vi.hoisted(() => ({ id: "feishu-test-plugin" }));
const setFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const registerFeishuSubagentHooksMock = vi.hoisted(() => vi.fn());

let createFeishuClient: CreateFeishuClient;
let createFeishuWSClient: CreateFeishuWSClient;
let clearClientCache: ClearClientCache;
let setFeishuClientRuntimeForTest: SetFeishuClientRuntimeForTest;
let FEISHU_HTTP_TIMEOUT_MS: number;
let FEISHU_HTTP_TIMEOUT_MAX_MS: number;
let FEISHU_HTTP_TIMEOUT_ENV_VAR: string;

let priorProxyEnv: Partial<Record<ProxyEnvKey, string | undefined>> = {};
let priorFeishuTimeoutEnv: string | undefined;

vi.mock("./channel.js", () => ({
  feishuPlugin: feishuPluginMock,
}));

vi.mock("./docx.js", () => ({
  registerFeishuDocTools: registerFeishuDocToolsMock,
}));

vi.mock("./chat.js", () => ({
  registerFeishuChatTools: registerFeishuChatToolsMock,
}));

vi.mock("./wiki.js", () => ({
  registerFeishuWikiTools: registerFeishuWikiToolsMock,
}));

vi.mock("./drive.js", () => ({
  registerFeishuDriveTools: registerFeishuDriveToolsMock,
}));

vi.mock("./perm.js", () => ({
  registerFeishuPermTools: registerFeishuPermToolsMock,
}));

vi.mock("./bitable.js", () => ({
  registerFeishuBitableTools: registerFeishuBitableToolsMock,
}));

vi.mock("./runtime.js", () => ({
  setFeishuRuntime: setFeishuRuntimeMock,
}));

vi.mock("./subagent-hooks.js", () => ({
  registerFeishuSubagentHooks: registerFeishuSubagentHooksMock,
}));

const baseAccount: ResolvedFeishuAccount = {
  accountId: "main",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  appId: "app_123",
  appSecret: "secret_123", // pragma: allowlist secret
  domain: "feishu",
  config: FeishuConfigSchema.parse({}),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type HttpInstanceLike = {
  get: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  post: (url: string, body?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

function readCallOptions(
  mock: { mock: { calls: unknown[][] } },
  index = -1,
): Record<string, unknown> {
  const call = index < 0 ? mock.mock.calls.at(index)?.[0] : mock.mock.calls[index]?.[0];
  return isRecord(call) ? call : {};
}

function firstWsClientOptions(): {
  agent?: unknown;
  wsConfig?: unknown;
  onError?: unknown;
  onReady?: unknown;
  onReconnected?: unknown;
  onReconnecting?: unknown;
} {
  const options = readCallOptions(wsClientCtorMock, 0);
  return {
    agent: options.agent,
    wsConfig: options.wsConfig,
    onError: options.onError,
    onReady: options.onReady,
    onReconnected: options.onReconnected,
    onReconnecting: options.onReconnecting,
  };
}

beforeAll(async () => {
  vi.doMock("@larksuiteoapi/node-sdk", () => ({
    AppType: { SelfBuild: "self" },
    Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
    LoggerLevel: { info: "info" },
    Client: clientCtorMock,
    WSClient: wsClientCtorMock,
    EventDispatcher: vi.fn(),
    defaultHttpInstance: mockBaseHttpInstance,
  }));
  vi.doMock("proxy-agent", () => ({
    ProxyAgent: proxyAgentCtorMock,
  }));

  ({
    createFeishuClient,
    createFeishuWSClient,
    clearClientCache,
    setFeishuClientRuntimeForTest,
    FEISHU_HTTP_TIMEOUT_MS,
    FEISHU_HTTP_TIMEOUT_MAX_MS,
    FEISHU_HTTP_TIMEOUT_ENV_VAR,
  } = await import("./client.js"));
});

beforeEach(() => {
  priorProxyEnv = {};
  priorFeishuTimeoutEnv = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.clearAllMocks();
  clearClientCache();
  setFeishuClientRuntimeForTest({
    sdk: {
      AppType: { SelfBuild: "self" } as never,
      Domain: {
        Feishu: "https://open.feishu.cn",
        Lark: "https://open.larksuite.com",
      } as never,
      LoggerLevel: { info: "info" } as never,
      Client: clientCtorMock as never,
      WSClient: wsClientCtorMock as never,
      EventDispatcher: vi.fn() as never,
      defaultHttpInstance: mockBaseHttpInstance as never,
    },
  });
});

afterEach(() => {
  for (const key of proxyEnvKeys) {
    const value = priorProxyEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (priorFeishuTimeoutEnv === undefined) {
    delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  } else {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = priorFeishuTimeoutEnv;
  }
  setFeishuClientRuntimeForTest();
});

describe("createFeishuClient HTTP timeout", () => {
  const getLastClientHttpInstance = (): HttpInstanceLike | undefined => {
    const httpInstance = readCallOptions(clientCtorMock).httpInstance;
    if (
      isRecord(httpInstance) &&
      typeof httpInstance.get === "function" &&
      typeof httpInstance.post === "function"
    ) {
      return {
        get: httpInstance.get as HttpInstanceLike["get"],
        post: httpInstance.post as HttpInstanceLike["post"],
      };
    }
    return undefined;
  };

  const expectGetCallTimeout = async (timeout: number) => {
    const httpInstance = getLastClientHttpInstance();
    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api");
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout }),
    );
  };

  it("passes a custom httpInstance with default timeout to Lark.Client", () => {
    createFeishuClient({ appId: "app_1", appSecret: "secret_1", accountId: "timeout-test" }); // pragma: allowlist secret

    expect(readCallOptions(clientCtorMock).httpInstance).toBeDefined();
  });

  it("injects default timeout into HTTP request options", async () => {
    createFeishuClient({ appId: "app_2", appSecret: "secret_2", accountId: "timeout-inject" }); // pragma: allowlist secret

    const httpInstance = getLastClientHttpInstance();

    expect(httpInstance).toBeDefined();
    await httpInstance?.post(
      "https://example.com/api",
      { data: 1 },
      { headers: { "X-Custom": "yes" } },
    );

    expect(mockBaseHttpInstance.post).toHaveBeenCalledWith(
      "https://example.com/api",
      { data: 1 },
      expect.objectContaining({ timeout: FEISHU_HTTP_TIMEOUT_MS, headers: { "X-Custom": "yes" } }),
    );
  });

  it("allows explicit timeout override per-request", async () => {
    createFeishuClient({ appId: "app_3", appSecret: "secret_3", accountId: "timeout-override" }); // pragma: allowlist secret

    const httpInstance = getLastClientHttpInstance();

    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api", { timeout: 5_000 });

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it("uses config-configured default timeout when provided", async () => {
    createFeishuClient({
      appId: "app_4",
      appSecret: "secret_4", // pragma: allowlist secret
      accountId: "timeout-config",
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(45_000);
  });

  it("falls back to default timeout when configured timeout is invalid", async () => {
    createFeishuClient({
      appId: "app_5",
      appSecret: "secret_5", // pragma: allowlist secret
      accountId: "timeout-config-invalid",
      config: { httpTimeoutMs: -1 },
    });

    await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MS);
  });

  it("uses env timeout override when provided and no direct timeout is set", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";

    createFeishuClient({
      appId: "app_8",
      appSecret: "secret_8", // pragma: allowlist secret
      accountId: "timeout-env-override",
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(60_000);
  });

  it("prefers direct timeout over env override", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";

    createFeishuClient({
      appId: "app_10",
      appSecret: "secret_10", // pragma: allowlist secret
      accountId: "timeout-direct-override",
      httpTimeoutMs: 120_000,
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(120_000);
  });

  it("clamps env timeout override to max bound", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = String(FEISHU_HTTP_TIMEOUT_MAX_MS + 123_456);

    createFeishuClient({
      appId: "app_9",
      appSecret: "secret_9", // pragma: allowlist secret
      accountId: "timeout-env-clamp",
    });

    await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MAX_MS);
  });

  it("recreates cached client when configured timeout changes", async () => {
    createFeishuClient({
      appId: "app_6",
      appSecret: "secret_6", // pragma: allowlist secret
      accountId: "timeout-cache-change",
      config: { httpTimeoutMs: 30_000 },
    });
    createFeishuClient({
      appId: "app_6",
      appSecret: "secret_6", // pragma: allowlist secret
      accountId: "timeout-cache-change",
      config: { httpTimeoutMs: 45_000 },
    });

    expect(clientCtorMock.mock.calls.length).toBe(2);
    const httpInstance = getLastClientHttpInstance();
    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api");

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 45_000 }),
    );
  });
});

describe("createFeishuWSClient proxy handling", () => {
  it("passes heartbeat wsConfig defaults to Lark.WSClient", async () => {
    await createFeishuWSClient(baseAccount);

    const options = firstWsClientOptions();
    expect(options.wsConfig).toEqual({
      PingInterval: 30,
      PingTimeout: 3,
    });
  });

  it("passes lifecycle callbacks while preserving heartbeat wsConfig defaults", async () => {
    const onError = vi.fn();
    const onReady = vi.fn();
    const onReconnected = vi.fn();
    const onReconnecting = vi.fn();

    await createFeishuWSClient(baseAccount, {
      onError,
      onReady,
      onReconnected,
      onReconnecting,
    });

    const options = firstWsClientOptions();
    expect(options.onError).toBe(onError);
    expect(options.onReady).toBe(onReady);
    expect(options.onReconnected).toBe(onReconnected);
    expect(options.onReconnecting).toBe(onReconnecting);
    expect(options.wsConfig).toEqual({
      PingInterval: 30,
      PingTimeout: 3,
    });
  });

  it("does not set a ws proxy agent when proxy env is absent", async () => {
    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).not.toHaveBeenCalled();
    const options = firstWsClientOptions();
    expect(options.agent).toBeUndefined();
  });

  it("creates a ws proxy agent when lowercase https_proxy is set", async () => {
    process.env.https_proxy = "http://lower-https:8001";

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });

  it("creates a ws proxy agent when uppercase HTTPS_PROXY is set", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });

  it("falls back to HTTP_PROXY for ws proxy agent creation", async () => {
    process.env.HTTP_PROXY = "http://upper-http:8999";

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });
});
