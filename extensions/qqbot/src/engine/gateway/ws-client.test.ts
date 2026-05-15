import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const webSocketCtorMock = vi.hoisted(() =>
  vi.fn(function webSocketCtorMockImpl(_url: string, _options?: Record<string, unknown>) {
    return { readyState: 0 };
  }),
);
const proxyAgentCtorMock = vi.hoisted(() =>
  vi.fn(function createAmbientNodeProxyAgentMockImpl() {
    return { proxied: true };
  }),
);
const proxyEnvKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
type ProxyEnvKey = (typeof proxyEnvKeys)[number];

vi.mock("ws", () => ({
  default: webSocketCtorMock,
}));

type CreateQQWSClient = typeof import("./ws-client.js").createQQWSClient;
let createQQWSClient: CreateQQWSClient;
let priorProxyEnv: Partial<Record<ProxyEnvKey, string | undefined>> = {};

beforeAll(async () => {
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
  ({ createQQWSClient } = await import("./ws-client.js"));
});

function expectWebSocketCtorCall(expected: unknown[]): void {
  const call = webSocketCtorMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected WebSocket constructor call");
  }
  expect(call).toEqual(expected);
}

describe("createQQWSClient", () => {
  beforeEach(() => {
    priorProxyEnv = {};
    for (const key of proxyEnvKeys) {
      priorProxyEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.clearAllMocks();
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
  });

  it("does not set a ws proxy agent when proxy env is absent", async () => {
    await createQQWSClient({
      gatewayUrl: "wss://qq.example.test/ws",
      userAgent: "openclaw-qqbot-test",
    });

    expect(webSocketCtorMock).toHaveBeenCalledTimes(1);
    expect(proxyAgentCtorMock).not.toHaveBeenCalled();
    expectWebSocketCtorCall([
      "wss://qq.example.test/ws",
      {
        headers: { "User-Agent": "openclaw-qqbot-test" },
      },
    ]);
  });

  it("creates a ws proxy agent when lowercase https_proxy is set", async () => {
    process.env.https_proxy = "http://lower-https:8001";

    await createQQWSClient({
      gatewayUrl: "wss://qq.example.test/ws",
      userAgent: "openclaw-qqbot-test",
    });

    expect(webSocketCtorMock).toHaveBeenCalledTimes(1);
    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expectWebSocketCtorCall([
      "wss://qq.example.test/ws",
      {
        agent: { proxied: true },
        headers: { "User-Agent": "openclaw-qqbot-test" },
      },
    ]);
  });

  it("creates a ws proxy agent when uppercase HTTPS_PROXY is set", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";

    await createQQWSClient({
      gatewayUrl: "wss://qq.example.test/ws",
      userAgent: "openclaw-qqbot-test",
    });

    expect(webSocketCtorMock).toHaveBeenCalledTimes(1);
    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expectWebSocketCtorCall([
      "wss://qq.example.test/ws",
      {
        agent: { proxied: true },
        headers: { "User-Agent": "openclaw-qqbot-test" },
      },
    ]);
  });

  it("falls back to HTTP_PROXY for ws proxy agent creation", async () => {
    process.env.HTTP_PROXY = "http://upper-http:8999";

    await createQQWSClient({
      gatewayUrl: "wss://qq.example.test/ws",
      userAgent: "openclaw-qqbot-test",
    });

    expect(webSocketCtorMock).toHaveBeenCalledTimes(1);
    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expectWebSocketCtorCall([
      "wss://qq.example.test/ws",
      {
        agent: { proxied: true },
        headers: { "User-Agent": "openclaw-qqbot-test" },
      },
    ]);
  });
});
