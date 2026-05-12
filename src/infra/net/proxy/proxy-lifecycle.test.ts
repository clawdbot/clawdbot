import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../undici-global-dispatcher.js", () => ({
  forceResetGlobalDispatcher: vi.fn(),
}));

vi.mock("global-agent", () => ({
  bootstrap: vi.fn(),
  createGlobalProxyAgent: vi.fn(),
}));

vi.mock("../../../logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { bootstrap as bootstrapGlobalAgent } from "global-agent";
import { logInfo, logWarn } from "../../../logger.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import { _resetActiveManagedProxyStateForTests } from "./active-proxy-state.js";
import {
  _resetGlobalAgentBootstrapForTests,
  registerManagedProxyGatewayLoopbackNoProxy,
  startProxy,
  stopProxy,
  type ProxyHandle,
} from "./proxy-lifecycle.js";

const mockForceResetGlobalDispatcher = vi.mocked(forceResetGlobalDispatcher);
const mockBootstrapGlobalAgent = vi.mocked(bootstrapGlobalAgent);
const mockLogInfo = vi.mocked(logInfo);
const mockLogWarn = vi.mocked(logWarn);

function expectProxyHandle(handle: Awaited<ReturnType<typeof startProxy>>): ProxyHandle {
  if (handle === null) {
    throw new Error("Expected managed proxy handle");
  }
  expect(handle.proxyUrl).not.toBe("");
  return handle;
}

function expectNoProxyUnregister(
  unregister: ReturnType<typeof registerManagedProxyGatewayLoopbackNoProxy>,
): () => void {
  expect(unregister).toBeTypeOf("function");
  if (typeof unregister !== "function") {
    throw new Error("Expected Gateway NO_PROXY unregister callback");
  }
  return unregister;
}

describe("startProxy", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToClean = [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
    "GLOBAL_AGENT_HTTP_PROXY",
    "GLOBAL_AGENT_HTTPS_PROXY",
    "GLOBAL_AGENT_FORCE_GLOBAL_AGENT",
    "GLOBAL_AGENT_NO_PROXY",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_LOOPBACK_MODE",
    "OPENCLAW_PROXY_URL",
  ];
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpGlobalAgent = http.globalAgent;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;
  const originalHttpsGlobalAgent = https.globalAgent;

  beforeEach(() => {
    for (const key of envKeysToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockForceResetGlobalDispatcher.mockReset();
    mockBootstrapGlobalAgent.mockReset();
    mockBootstrapGlobalAgent.mockImplementation(() => {
      const env = process.env as Record<string, string | undefined>;
      const namespace = env["GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE"] ?? "GLOBAL_AGENT_";
      (global as Record<string, unknown>)["GLOBAL_AGENT"] = {
        HTTP_PROXY: env[`${namespace}HTTP_PROXY`] ?? "",
        HTTPS_PROXY: env[`${namespace}HTTPS_PROXY`] ?? "",
        NO_PROXY: env[`${namespace}NO_PROXY`] ?? null,
      };
    });
    mockLogInfo.mockReset();
    mockLogWarn.mockReset();
    _resetGlobalAgentBootstrapForTests();
    _resetActiveManagedProxyStateForTests();
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = undefined;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    http.globalAgent = originalHttpGlobalAgent;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
    https.globalAgent = originalHttpsGlobalAgent;
  });

  afterEach(() => {
    for (const key of envKeysToClean) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = undefined;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    http.globalAgent = originalHttpGlobalAgent;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
    https.globalAgent = originalHttpsGlobalAgent;
  });

  it("returns null silently and does not touch env when not explicitly enabled", async () => {
    const handle = await startProxy(undefined);

    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBeUndefined();
    expect(mockForceResetGlobalDispatcher).not.toHaveBeenCalled();
    expect(mockBootstrapGlobalAgent).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("throws when enabled without a proxy URL", async () => {
    await expect(startProxy({ enabled: true })).rejects.toThrow(
      "proxy: enabled but no HTTP proxy URL is configured",
    );

    expect(process.env["http_proxy"]).toBeUndefined();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("exposes the active managed proxy URL", async () => {
    const { getActiveManagedProxyUrl } = await import("./active-proxy-state.js");

    expect(getActiveManagedProxyUrl()).toBeUndefined();

    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    const activeProxyUrl = getActiveManagedProxyUrl();
    if (activeProxyUrl === undefined) {
      throw new Error("Expected active managed proxy URL");
    }
    expect(activeProxyUrl).toBeInstanceOf(URL);
    expect(activeProxyUrl.href).toBe("http://127.0.0.1:3128/");

    await stopProxy(expectProxyHandle(handle));

    expect(getActiveManagedProxyUrl()).toBeUndefined();
  });

  it("uses OPENCLAW_PROXY_URL when config proxyUrl is omitted", async () => {
    process.env["OPENCLAW_PROXY_URL"] = "http://127.0.0.1:3128";

    const handle = await startProxy({ enabled: true });

    expect(expectProxyHandle(handle).proxyUrl).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
  });

  it("prefers config proxyUrl over OPENCLAW_PROXY_URL", async () => {
    process.env["OPENCLAW_PROXY_URL"] = "http://127.0.0.1:3128";

    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3129",
    });

    expect(expectProxyHandle(handle).proxyUrl).toBe("http://127.0.0.1:3129");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3129");
  });

  it("throws for HTTPS proxy URLs from OPENCLAW_PROXY_URL", async () => {
    process.env["OPENCLAW_PROXY_URL"] = "https://127.0.0.1:3128";

    await expect(startProxy({ enabled: true })).rejects.toThrow("http:// forward proxy");

    expect(process.env["HTTP_PROXY"]).toBeUndefined();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("sets both undici and global-agent proxy env vars", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expectProxyHandle(handle);
    expect(process.env["http_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["https_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBe("true");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");
    expect(process.env["OPENCLAW_PROXY_LOOPBACK_MODE"]).toBe("gateway-only");
  });

  it("persists loopbackMode in env for forked child CLIs", async () => {
    const { getActiveManagedProxyLoopbackMode } = await import("./active-proxy-state.js");
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "block",
    });

    expect(process.env["OPENCLAW_PROXY_LOOPBACK_MODE"]).toBe("block");
    expect(getActiveManagedProxyLoopbackMode()).toBe("block");

    await stopProxy(handle);
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = "proxy";

    expect(getActiveManagedProxyLoopbackMode()).toBe("proxy");
  });

  it("redacts proxy credentials before logging the active proxy URL", async () => {
    await startProxy({
      enabled: true,
      proxyUrl: "http://user:pass@127.0.0.1:3128",
    });

    expect(mockLogInfo).toHaveBeenCalledWith(
      "proxy: routing process HTTP traffic through external proxy http://127.0.0.1:3128",
    );
    expect(
      mockLogInfo.mock.calls.some((call) =>
        call.some((value) => typeof value === "string" && value.includes("user:pass")),
      ),
    ).toBe(false);
  });

  it("clears NO_PROXY so internal destinations do not bypass the filtering proxy", async () => {
    process.env["NO_PROXY"] = "127.0.0.1,localhost,corp.example.com";
    process.env["no_proxy"] = "localhost";
    process.env["GLOBAL_AGENT_NO_PROXY"] = "localhost";

    await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(process.env["no_proxy"]).toBe("");
    expect(process.env["NO_PROXY"]).toBe("");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toBe("");
  });

  it("activates undici and global-agent routing", async () => {
    await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
    expect(mockBootstrapGlobalAgent).toHaveBeenCalledOnce();
  });

  it("restores previous proxy env and global-agent state on stop", async () => {
    process.env["HTTP_PROXY"] = "http://previous.example.com:8080";
    process.env["NO_PROXY"] = "corp.example.com";
    process.env["GLOBAL_AGENT_HTTP_PROXY"] = "http://previous-global.example.com:8080";
    process.env["GLOBAL_AGENT_HTTPS_PROXY"] = "http://previous-global.example.com:8443";
    process.env["GLOBAL_AGENT_NO_PROXY"] = "global.corp.example.com";
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
    };

    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    const proxyHandle = expectProxyHandle(handle);
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["NO_PROXY"]).toBe("");
    mockForceResetGlobalDispatcher.mockClear();

    await stopProxy(proxyHandle);

    expect(process.env["HTTP_PROXY"]).toBe("http://previous.example.com:8080");
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe("http://previous-global.example.com:8080");
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBe("http://previous-global.example.com:8443");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toBe("global.corp.example.com");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBeUndefined();
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    expect(agent["HTTP_PROXY"]).toBe("");
    expect(agent["HTTPS_PROXY"]).toBe("");
    expect(agent["NO_PROXY"]).toBeUndefined();
    expect(agent["forceGlobalAgent"]).toBeUndefined();
    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
  });

  it("restores node http and https globals on stop", async () => {
    const patchedHttpRequest = vi.fn() as unknown as typeof http.request;
    const patchedHttpGet = vi.fn() as unknown as typeof http.get;
    const patchedHttpsRequest = vi.fn() as unknown as typeof https.request;
    const patchedHttpsGet = vi.fn() as unknown as typeof https.get;
    const patchedHttpAgent = new http.Agent();
    const patchedHttpsAgent = new https.Agent();
    mockBootstrapGlobalAgent.mockImplementationOnce(() => {
      http.request = patchedHttpRequest;
      http.get = patchedHttpGet;
      http.globalAgent = patchedHttpAgent;
      https.request = patchedHttpsRequest;
      https.get = patchedHttpsGet;
      https.globalAgent = patchedHttpsAgent;
      (global as Record<string, unknown>)["GLOBAL_AGENT"] = {
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
      };
    });

    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(http.request).toBe(patchedHttpRequest);

    await stopProxy(handle);

    expect(http.request).toBe(originalHttpRequest);
    expect(http.get).toBe(originalHttpGet);
    expect(http.globalAgent).toBe(originalHttpGlobalAgent);
    expect(https.request).toBe(originalHttpsRequest);
    expect(https.get).toBe(originalHttpsGet);
    expect(https.globalAgent).toBe(originalHttpsGlobalAgent);
    expect((global as Record<string, unknown>)["GLOBAL_AGENT"]).toBeUndefined();
  });

  it("keeps same-url overlapping handles active until the final stop", async () => {
    const patchedHttpRequest = vi.fn() as unknown as typeof http.request;
    const patchedHttpGet = vi.fn() as unknown as typeof http.get;
    const patchedHttpsRequest = vi.fn() as unknown as typeof https.request;
    const patchedHttpsGet = vi.fn() as unknown as typeof https.get;
    mockBootstrapGlobalAgent.mockImplementationOnce(() => {
      http.request = patchedHttpRequest;
      http.get = patchedHttpGet;
      https.request = patchedHttpsRequest;
      https.get = patchedHttpsGet;
      (global as Record<string, unknown>)["GLOBAL_AGENT"] = {
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
      };
    });

    const firstHandle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    const secondHandle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
    expect(mockBootstrapGlobalAgent).toHaveBeenCalledOnce();
    expect(http.request).toBe(patchedHttpRequest);
    expect(https.request).toBe(patchedHttpsRequest);
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");

    await stopProxy(secondHandle);

    expect(http.request).toBe(patchedHttpRequest);
    expect(https.request).toBe(patchedHttpsRequest);
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");

    await stopProxy(firstHandle);

    expect(http.request).toBe(originalHttpRequest);
    expect(http.get).toBe(originalHttpGet);
    expect(https.request).toBe(originalHttpsRequest);
    expect(https.get).toBe(originalHttpsGet);
    expect(process.env["HTTP_PROXY"]).toBeUndefined();
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBeUndefined();
  });

  it("rejects overlapping handles with different managed proxy URLs", async () => {
    const firstHandle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    await expect(
      startProxy({
        enabled: true,
        proxyUrl: "http://127.0.0.1:3129",
      }),
    ).rejects.toThrow("cannot activate a managed proxy");

    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");

    await stopProxy(firstHandle);
  });

  it("rejects overlapping handles with the same proxy URL but different loopback modes", async () => {
    const firstHandle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "gateway-only",
    });

    await expect(
      startProxy({
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
        loopbackMode: "block",
      }),
    ).rejects.toThrow("cannot activate a managed proxy with a different proxy.loopbackMode");

    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");

    await stopProxy(firstHandle);
  });

  it("restores env and throws when undici activation fails", async () => {
    mockForceResetGlobalDispatcher.mockImplementationOnce(() => {
      throw new Error("dispatcher failed");
    });

    await expect(
      startProxy({
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      }),
    ).rejects.toThrow("failed to activate external proxy routing");

    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBeUndefined();
  });

  it("restores env and throws when global-agent bootstrap fails", async () => {
    mockBootstrapGlobalAgent.mockImplementationOnce(() => {
      throw new Error("bootstrap failed");
    });

    await expect(
      startProxy({
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      }),
    ).rejects.toThrow("failed to activate external proxy routing");

    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBeUndefined();
  });

  it("registers exact Gateway loopback authorities in global-agent NO_PROXY", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;

    const unregister = expectNoProxyUnregister(
      registerManagedProxyGatewayLoopbackNoProxy("ws://127.0.0.1:18789"),
    );
    expect(agent["NO_PROXY"]).toBe("127.0.0.1:18789");

    unregister();
    expect(agent["NO_PROXY"]).toBeNull();
    await stopProxy(handle);
  });

  it("accepts literal loopback IPs and localhost for Gateway NO_PROXY registration", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;

    const unregisterIpv6 = expectNoProxyUnregister(
      registerManagedProxyGatewayLoopbackNoProxy("ws://[::1]:18789"),
    );
    expect(agent["NO_PROXY"]).toBe("[::1]:18789");
    unregisterIpv6();

    const unregisterLocalhost = expectNoProxyUnregister(
      registerManagedProxyGatewayLoopbackNoProxy("ws://localhost.:18789"),
    );
    expect(agent["NO_PROXY"]).toBe("localhost.:18789");
    unregisterLocalhost();

    await stopProxy(handle);
  });

  it("does not register Gateway NO_PROXY for non-loopback URLs", () => {
    expect(registerManagedProxyGatewayLoopbackNoProxy("wss://gateway.example.com")).toBeUndefined();
  });

  it("allows Gateway NO_PROXY registration for custom configured loopback ports", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;

    const unregister = expectNoProxyUnregister(
      registerManagedProxyGatewayLoopbackNoProxy("ws://127.0.0.1:3000"),
    );
    expect(agent["NO_PROXY"]).toBe("127.0.0.1:3000");

    unregister();
    await stopProxy(handle);
  });

  it("blocks Gateway NO_PROXY registration when active proxy loopbackMode is block", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "block",
    });

    try {
      expect(() => registerManagedProxyGatewayLoopbackNoProxy("ws://127.0.0.1:18789")).toThrow(
        "blocked by proxy.loopbackMode",
      );
    } finally {
      await stopProxy(handle);
    }
  });

  it("does not register Gateway NO_PROXY when active proxy loopbackMode is proxy", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "proxy",
    });
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;

    try {
      const unregister = registerManagedProxyGatewayLoopbackNoProxy("ws://127.0.0.1:18789");
      expect(agent["NO_PROXY"]).toBe("");
      expect(unregister).toBeUndefined();
    } finally {
      await stopProxy(handle);
    }
  });

  it("restores the active global-agent NO_PROXY value after Gateway registration", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    agent["NO_PROXY"] = "corp.example.com";

    const unregister = expectNoProxyUnregister(
      registerManagedProxyGatewayLoopbackNoProxy("ws://127.0.0.1:18789"),
    );
    expect(agent["NO_PROXY"]).toBe("corp.example.com,127.0.0.1:18789");

    unregister();
    expect(agent["NO_PROXY"]).toBe("corp.example.com");
    await stopProxy(handle);
  });

  it("kill restores env synchronously during hard process exit", async () => {
    process.env["NO_PROXY"] = "corp.example.com";
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expectProxyHandle(handle).kill("SIGTERM");

    expect(process.env["HTTP_PROXY"]).toBeUndefined();
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
  });

  it("stopProxy is a no-op when handle is null", async () => {
    await expect(stopProxy(null)).resolves.toBeUndefined();
  });
});
