// Feishu tests cover client plugin behavior.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FEISHU_HTTP_TIMEOUT_MS } from "./client-timeout.js";
import { FeishuConfigSchema } from "./config-schema.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";
const FEISHU_HTTP_TIMEOUT_MAX_MS = 300_000;

type CreateFeishuClient = typeof import("./client.js").createFeishuClient;
type CreateFeishuWSClient = typeof import("./client.js").createFeishuWSClient;
type GetFeishuUserAgent = typeof import("./client.js").getFeishuUserAgent;
type ResetFeishuProxyAgentForTest = typeof import("./client.js").resetFeishuProxyAgentForTest;

const requestInterceptorState = vi.hoisted(() => {
  let registered: ((req: unknown) => unknown) | undefined;
  return {
    get registered() {
      return registered;
    },
    use: vi.fn((fn: (req: unknown) => unknown) => {
      registered = fn;
    }),
  };
});
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
const proxyAgentInstance = vi.hoisted(() => ({ proxied: true, destroy: vi.fn() }));
const proxyAgentCtorMock = vi.hoisted(() => vi.fn(() => proxyAgentInstance));
const mockBaseHttpInstance = vi.hoisted(() => {
  const requestInterceptors = { use: requestInterceptorState.use };
  Object.defineProperty(requestInterceptors, "handlers", {
    configurable: true,
    get() {
      throw new Error("Do not read axios private interceptor handlers");
    },
    set() {
      throw new Error("Do not write axios private interceptor handlers");
    },
  });
  return {
    request: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    head: vi.fn().mockResolvedValue({}),
    options: vi.fn().mockResolvedValue({}),
    interceptors: {
      request: requestInterceptors,
    },
  };
});
const proxyEnvKeys = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "OPENCLAW_PROXY_ACTIVE",
] as const;
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
let getFeishuUserAgent: GetFeishuUserAgent;
let resetFeishuProxyAgentForTest: ResetFeishuProxyAgentForTest;

let priorProxyEnv: Partial<Record<ProxyEnvKey, string | undefined>> = {};
let priorFeishuTimeoutEnv: string | undefined;

function setFeishuTestEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    Reflect.set(process.env, key, value);
  }
}

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
  request: (options?: Record<string, unknown>) => Promise<unknown>;
  get: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  post: (url: string, body?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

function requireHttpInstance(value: unknown): HttpInstanceLike {
  if (
    isRecord(value) &&
    typeof value.request === "function" &&
    typeof value.get === "function" &&
    typeof value.post === "function"
  ) {
    return {
      request: value.request as HttpInstanceLike["request"],
      get: value.get as HttpInstanceLike["get"],
      post: value.post as HttpInstanceLike["post"],
    };
  }
  throw new Error("expected Feishu HTTP instance");
}

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
  httpInstance?: unknown;
} {
  const options = readCallOptions(wsClientCtorMock, 0);
  return {
    agent: options.agent,
    wsConfig: options.wsConfig,
    onError: options.onError,
    onReady: options.onReady,
    onReconnected: options.onReconnected,
    onReconnecting: options.onReconnecting,
    httpInstance: options.httpInstance,
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
  vi.doMock("@openclaw/proxyline", () => ({
    createAmbientNodeProxyAgent: proxyAgentCtorMock,
    hasAmbientNodeProxyConfigured: vi.fn(() =>
      Boolean(
        process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.HTTP_PROXY ??
        process.env.http_proxy,
      ),
    ),
  }));

  ({ createFeishuClient, createFeishuWSClient, getFeishuUserAgent, resetFeishuProxyAgentForTest } =
    await import("./client.js"));
});

beforeEach(() => {
  priorProxyEnv = {};
  priorFeishuTimeoutEnv = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, undefined);
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    setFeishuTestEnvValue(key, undefined);
  }
  resetFeishuProxyAgentForTest();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of proxyEnvKeys) {
    setFeishuTestEnvValue(key, priorProxyEnv[key]);
  }
  setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, priorFeishuTimeoutEnv);
});

afterAll(() => {
  resetFeishuProxyAgentForTest();
  vi.doUnmock("./channel.js");
  vi.doUnmock("./docx.js");
  vi.doUnmock("./chat.js");
  vi.doUnmock("./wiki.js");
  vi.doUnmock("./drive.js");
  vi.doUnmock("./perm.js");
  vi.doUnmock("./bitable.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./subagent-hooks.js");
  vi.doUnmock("@larksuiteoapi/node-sdk");
  vi.doUnmock("@openclaw/proxyline");
  vi.resetModules();
});

describe("Feishu default User-Agent interceptor", () => {
  it("registers through the public interceptor API and overrides the SDK User-Agent", () => {
    expect(requestInterceptorState.registered).toBeTypeOf("function");

    const req = { headers: { "User-Agent": "oapi-node-sdk/1.0.0" } };
    expect(requestInterceptorState.registered?.(req)).toBe(req);

    expect(req.headers["User-Agent"]).toBe(getFeishuUserAgent());
  });

  it("sets the User-Agent on AxiosHeaders-like request headers", () => {
    const headers = { set: vi.fn() };
    const req = { headers };

    expect(requestInterceptorState.registered?.(req)).toBe(req);

    expect(headers.set).toHaveBeenCalledWith("User-Agent", getFeishuUserAgent());
  });
});

describe("createFeishuClient HTTP timeout", () => {
  const readLastClientHttpInstance = (): HttpInstanceLike =>
    requireHttpInstance(readCallOptions(clientCtorMock).httpInstance);

  const expectGetCallTimeout = async (timeout: number) => {
    const httpInstance = readLastClientHttpInstance();
    await httpInstance.get("https://example.com/api");
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith("https://example.com/api", { timeout });
  };

  it("passes a custom httpInstance with default timeout to Lark.Client", () => {
    createFeishuClient({ appId: "app_1", appSecret: "secret_1", accountId: "timeout-test" }); // pragma: allowlist secret

    const httpInstance = readLastClientHttpInstance();
    expect(typeof httpInstance.get).toBe("function");
    expect(typeof httpInstance.post).toBe("function");
  });

  it("injects default timeout into HTTP request options", async () => {
    createFeishuClient({ appId: "app_2", appSecret: "secret_2", accountId: "timeout-inject" }); // pragma: allowlist secret

    const httpInstance = readLastClientHttpInstance();

    await httpInstance.post(
      "https://example.com/api",
      { data: 1 },
      { headers: { "X-Custom": "yes" } },
    );

    expect(mockBaseHttpInstance.post).toHaveBeenCalledWith(
      "https://example.com/api",
      { data: 1 },
      { timeout: FEISHU_HTTP_TIMEOUT_MS, headers: { "X-Custom": "yes" } },
    );
  });

  it("allows explicit timeout override per-request", async () => {
    createFeishuClient({ appId: "app_3", appSecret: "secret_3", accountId: "timeout-override" }); // pragma: allowlist secret

    const httpInstance = readLastClientHttpInstance();

    await httpInstance.get("https://example.com/api", { timeout: 5_000 });

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith("https://example.com/api", {
      timeout: 5_000,
    });
  });

  it.each([
    {
      kind: "file",
      url: "https://open.feishu.cn/open-apis/im/v1/files",
      data: { file_type: "stream", file_name: "tiny.txt", file: Buffer.from("tiny") },
      mediaField: "file",
      mediaBytes: Buffer.from("tiny"),
      fileName: "tiny.txt",
      scalarField: "file_type",
      scalarValue: "stream",
    },
    {
      kind: "image",
      url: "https://open.feishu.cn/open-apis/im/v1/images",
      data: { image_type: "message", image: Buffer.from("pixels") },
      mediaField: "image",
      mediaBytes: Buffer.from("pixels"),
      fileName: "image.bin",
      scalarField: "image_type",
      scalarValue: "message",
    },
  ])("normalizes Feishu SDK $kind uploads to explicit FormData", async (testCase) => {
    createFeishuClient({
      appId: `app_upload_${testCase.kind}`,
      appSecret: "test-app-secret", // pragma: allowlist secret
      accountId: `multipart-upload-${testCase.kind}`,
    });
    const httpInstance = readLastClientHttpInstance();

    await httpInstance.request({
      url: testCase.url,
      method: "POST",
      headers: { "Content-Type": "multipart/form-data", Authorization: "Bearer test-token" },
      data: testCase.data,
    });

    const delegated = readCallOptions(mockBaseHttpInstance.request);
    expect(delegated.timeout).toBe(FEISHU_HTTP_TIMEOUT_MS);
    expect(delegated.headers).toEqual({
      "Content-Type": "multipart/form-data",
      Authorization: "Bearer test-token",
    });
    const form = delegated.data as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get(testCase.scalarField)).toBe(testCase.scalarValue);
    const media = form.get(testCase.mediaField) as File;
    expect(media).toBeInstanceOf(Blob);
    expect(media.name).toBe(testCase.fileName);
    expect(Buffer.from(await media.arrayBuffer())).toEqual(testCase.mediaBytes);
  });

  it.each([
    {
      name: "other endpoints",
      url: "https://open.feishu.cn/open-apis/drive/v1/files/upload_all",
      method: "POST",
    },
    {
      name: "upload paths mentioned only in a query",
      url: "https://open.feishu.cn/upload?return=/open-apis/im/v1/files",
      method: "POST",
    },
    {
      name: "non-POST requests",
      url: "https://open.feishu.cn/open-apis/im/v1/files",
      method: "GET",
    },
  ])("leaves $name on the SDK multipart serialization path", async ({ url, method }) => {
    createFeishuClient({
      appId: `app_upload_other_${method}`,
      appSecret: "test-app-secret", // pragma: allowlist secret
      accountId: `multipart-upload-other-${method}-${url.length}`,
    });
    const httpInstance = readLastClientHttpInstance();
    const data = { file_name: "drive.txt", file: Buffer.from("drive") };

    await httpInstance.request({
      url,
      method,
      headers: { "Content-Type": "multipart/form-data" },
      data,
    });

    expect(readCallOptions(mockBaseHttpInstance.request).data).toBe(data);
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
    setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, "60000");

    createFeishuClient({
      appId: "app_8",
      appSecret: "secret_8", // pragma: allowlist secret
      accountId: "timeout-env-override",
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(60_000);
  });

  it("ignores non-decimal env timeout overrides", async () => {
    for (const value of ["0x10", "1e3", "10.5"]) {
      setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, value);

      createFeishuClient({
        appId: `app-${value}`,
        appSecret: "secret-env-timeout", // pragma: allowlist secret
        accountId: `timeout-env-invalid-${value}`,
      });

      await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MS);
      mockBaseHttpInstance.get.mockClear();
    }
  });

  it("prefers direct timeout over env override", async () => {
    setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, "60000");

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
    setFeishuTestEnvValue(
      FEISHU_HTTP_TIMEOUT_ENV_VAR,
      String(FEISHU_HTTP_TIMEOUT_MAX_MS + 123_456),
    );

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
    const httpInstance = readLastClientHttpInstance();
    await httpInstance.get("https://example.com/api");

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith("https://example.com/api", {
      timeout: 45_000,
    });
  });

  it("uses OpenClaw's ambient proxy agent for Feishu HTTP API requests", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";

    createFeishuClient({
      appId: "app_11",
      appSecret: "secret_11", // pragma: allowlist secret
      accountId: "http-proxy-agent",
    });

    const httpInstance = readLastClientHttpInstance();
    await httpInstance.post("https://example.com/api", { data: 1 });
    await httpInstance.get("https://example.com/other");

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(mockBaseHttpInstance.post).toHaveBeenCalledWith(
      "https://example.com/api",
      { data: 1 },
      {
        timeout: FEISHU_HTTP_TIMEOUT_MS,
        httpAgent: proxyAgentInstance,
        httpsAgent: proxyAgentInstance,
        proxy: false,
      },
    );
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith("https://example.com/other", {
      timeout: FEISHU_HTTP_TIMEOUT_MS,
      httpAgent: proxyAgentInstance,
      httpsAgent: proxyAgentInstance,
      proxy: false,
    });
  });

  it("preserves request-level agents while disabling axios ambient proxy handling", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    const callerHttpAgent = { caller: "http" };
    const callerHttpsAgent = { caller: "https" };

    createFeishuClient({
      appId: "app_12",
      appSecret: "secret_12", // pragma: allowlist secret
      accountId: "http-proxy-preserve-agent",
    });

    const httpInstance = readLastClientHttpInstance();
    await httpInstance.request({
      url: "https://example.com/api",
      httpAgent: callerHttpAgent,
      httpsAgent: callerHttpsAgent,
    });

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(mockBaseHttpInstance.request).toHaveBeenCalledWith({
      url: "https://example.com/api",
      timeout: FEISHU_HTTP_TIMEOUT_MS,
      httpAgent: callerHttpAgent,
      httpsAgent: callerHttpsAgent,
      proxy: false,
    });
  });

  it("overrides request-level agents while managed proxy mode is active", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    const callerHttpAgent = { caller: "http" };
    const callerHttpsAgent = { caller: "https" };

    createFeishuClient({
      appId: "app_13",
      appSecret: "secret_13", // pragma: allowlist secret
      accountId: "http-proxy-managed-agent",
    });

    const httpInstance = readLastClientHttpInstance();
    await httpInstance.request({
      url: "https://example.com/api",
      httpAgent: callerHttpAgent,
      httpsAgent: callerHttpsAgent,
    });

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(mockBaseHttpInstance.request).toHaveBeenCalledWith({
      url: "https://example.com/api",
      timeout: FEISHU_HTTP_TIMEOUT_MS,
      httpAgent: proxyAgentInstance,
      httpsAgent: proxyAgentInstance,
      proxy: false,
    });
  });

  it("falls back to Axios ambient proxy handling when agent creation fails", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    proxyAgentCtorMock.mockImplementationOnce(() => {
      throw new Error("proxy agent failed");
    });

    createFeishuClient({
      ...baseAccount,
      accountId: "http-proxy-fallback",
    });

    const httpInstance = readLastClientHttpInstance();
    await httpInstance.request({ url: "https://example.com/api" });

    expect(mockBaseHttpInstance.request).toHaveBeenCalledWith({
      url: "https://example.com/api",
      timeout: FEISHU_HTTP_TIMEOUT_MS,
    });
  });

  it("fails closed when managed proxy agent creation fails", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    proxyAgentCtorMock.mockImplementationOnce(() => {
      throw new Error("proxy agent failed");
    });

    createFeishuClient({
      ...baseAccount,
      accountId: "http-proxy-managed-failure",
    });

    const httpInstance = readLastClientHttpInstance();
    await expect(httpInstance.request({ url: "https://example.com/api" })).rejects.toThrow(
      "Feishu managed proxy is active but no proxy agent could be created",
    );
    expect(mockBaseHttpInstance.request).not.toHaveBeenCalled();
  });
});

describe("createFeishuWSClient proxy handling", () => {
  it("passes heartbeat wsConfig defaults to Lark.WSClient", async () => {
    await createFeishuWSClient(baseAccount);

    const options = firstWsClientOptions();
    expect(options.wsConfig).toEqual({
      pingTimeout: 3,
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
      pingTimeout: 3,
    });
  });

  it("passes the proxy-aware HTTP instance to Lark.WSClient bootstrap requests", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";

    await createFeishuWSClient(baseAccount);

    const options = firstWsClientOptions();
    const httpInstance = requireHttpInstance(options.httpInstance);
    await httpInstance.request({ url: "https://open.feishu.cn/open-apis/ws/v1" });

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(options.agent).toBe(proxyAgentInstance);
    expect(mockBaseHttpInstance.request).toHaveBeenCalledWith({
      url: "https://open.feishu.cn/open-apis/ws/v1",
      timeout: FEISHU_HTTP_TIMEOUT_MS,
      httpAgent: proxyAgentInstance,
      httpsAgent: proxyAgentInstance,
      proxy: false,
    });
  });

  it("does not set a ws proxy agent when proxy env is absent", async () => {
    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).not.toHaveBeenCalled();
    const options = firstWsClientOptions();
    expect(options.agent).toBeUndefined();
  });

  it("creates a ws proxy agent when lowercase https_proxy is set", async () => {
    setFeishuTestEnvValue("https_proxy", "http://lower-https:8001");

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toBe(proxyAgentInstance);
  });

  it("creates a ws proxy agent when uppercase HTTPS_PROXY is set", async () => {
    setFeishuTestEnvValue("HTTPS_PROXY", "http://upper-https:8002");

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toBe(proxyAgentInstance);
  });

  it("falls back to HTTP_PROXY for ws proxy agent creation", async () => {
    setFeishuTestEnvValue("HTTP_PROXY", "http://upper-http:8999");

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toBe(proxyAgentInstance);
  });
});
