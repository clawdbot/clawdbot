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
  dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane,
  startProxy,
  stopProxy,
} from "./proxy-lifecycle.js";

const mockForceResetGlobalDispatcher = vi.mocked(forceResetGlobalDispatcher);
const mockBootstrapGlobalAgent = vi.mocked(bootstrapGlobalAgent);
const mockLogInfo = vi.mocked(logInfo);
const mockLogWarn = vi.mocked(logWarn);

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

    expect(getActiveManagedProxyUrl()?.href).toBe("http://127.0.0.1:3128/");

    await stopProxy(handle);

    expect(getActiveManagedProxyUrl()).toBeUndefined();
  });

  it("uses OPENCLAW_PROXY_URL when config proxyUrl is omitted", async () => {
    process.env["OPENCLAW_PROXY_URL"] = "http://127.0.0.1:3128";

    const handle = await startProxy({ enabled: true });

    expect(handle?.proxyUrl).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
  });

  it("prefers config proxyUrl over OPENCLAW_PROXY_URL", async () => {
    process.env["OPENCLAW_PROXY_URL"] = "http://127.0.0.1:3128";

    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3129",
    });

    expect(handle?.proxyUrl).toBe("http://127.0.0.1:3129");
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

    expect(handle).not.toBeNull();
    expect(process.env["http_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["https_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBe("true");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");
  });

  it("redacts proxy credentials before logging the active proxy URL", async () => {
    await startProxy({
      enabled: true,
      proxyUrl: "http://user:pass@127.0.0.1:3128",
    });

    expect(mockLogInfo).toHaveBeenCalledWith(
      "proxy: routing process HTTP traffic through external proxy http://127.0.0.1:3128",
    );
    expect(mockLogInfo).not.toHaveBeenCalledWith(expect.stringContaining("user:pass"));
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

    expect(handle).not.toBeNull();
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["NO_PROXY"]).toBe("");
    mockForceResetGlobalDispatcher.mockClear();

    await stopProxy(handle);

    expect(process.env["HTTP_PROXY"]).toBe("http://previous.example.com:8080");
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe("http://previous-global.example.com:8080");
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBe("http://previous-global.example.com:8443");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toBe("global.corp.example.com");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBeUndefined();
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    expect(agent["HTTP_PROXY"]).toBe("http://previous-global.example.com:8080");
    expect(agent["HTTPS_PROXY"]).toBe("http://previous-global.example.com:8443");
    expect(agent["NO_PROXY"]).toBe("global.corp.example.com");
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

  it("temporarily restores the original node HTTP stack for Gateway loopback control-plane setup", async () => {
    const patchedHttpRequest = vi.fn() as unknown as typeof http.request;
    const patchedHttpGet = vi.fn() as unknown as typeof http.get;
    mockBootstrapGlobalAgent.mockImplementationOnce(() => {
      http.request = patchedHttpRequest;
      http.get = patchedHttpGet;
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

    const requestDuringBypass = dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(
      "ws://127.0.0.1:18789",
      () => http.request,
    );

    expect(requestDuringBypass).toBe(originalHttpRequest);
    expect(http.request).toBe(patchedHttpRequest);

    await stopProxy(handle);
  });

  it("allows the Gateway control-plane bypass for literal loopback IPs and localhost", () => {
    expect(
      dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(
        "ws://127.0.0.1:18789",
        () => "ok",
      ),
    ).toBe("ok");
    expect(
      dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane("ws://[::1]:18789", () => "ok"),
    ).toBe("ok");
    expect(
      dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(
        "ws://localhost:18789",
        () => "ok",
      ),
    ).toBe("ok");
    expect(
      dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(
        "ws://localhost.:18789",
        () => "ok",
      ),
    ).toBe("ok");
  });

  it("rejects dangerous Gateway control-plane bypass for non-loopback URLs", () => {
    expect(() =>
      dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(
        "wss://gateway.example.com",
        () => undefined,
      ),
    ).toThrow("loopback-only");
  });

  it("temporarily clears inherited proxy env for Gateway control-plane setup", () => {
    process.env["http_proxy"] = "http://lower-http.example.com:8080";
    process.env["https_proxy"] = "http://lower-https.example.com:8080";
    process.env["HTTP_PROXY"] = "http://upper-http.example.com:8080";
    process.env["HTTPS_PROXY"] = "http://upper-https.example.com:8080";
    process.env["all_proxy"] = "http://lower-all.example.com:8080";
    process.env["ALL_PROXY"] = "http://upper-all.example.com:8080";
    process.env["NO_PROXY"] = "localhost";
    process.env["no_proxy"] = "127.0.0.1";
    process.env["GLOBAL_AGENT_HTTP_PROXY"] = "http://global-http.example.com:8080";
    process.env["GLOBAL_AGENT_HTTPS_PROXY"] = "http://global-https.example.com:8080";
    process.env["GLOBAL_AGENT_NO_PROXY"] = "localhost";
    process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] = "true";
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";

    const during = dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(
      "ws://localhost:18789",
      () => ({
        httpProxy: process.env["HTTP_PROXY"],
        httpsProxy: process.env["HTTPS_PROXY"],
        allProxy: process.env["ALL_PROXY"],
        lowerAllProxy: process.env["all_proxy"],
        noProxy: process.env["NO_PROXY"],
        globalProxy: process.env["GLOBAL_AGENT_HTTP_PROXY"],
        proxyActive: process.env["OPENCLAW_PROXY_ACTIVE"],
      }),
    );

    expect(during).toEqual({
      httpProxy: undefined,
      httpsProxy: undefined,
      allProxy: undefined,
      lowerAllProxy: undefined,
      noProxy: undefined,
      globalProxy: undefined,
      proxyActive: undefined,
    });
    expect(process.env["HTTP_PROXY"]).toBe("http://upper-http.example.com:8080");
    expect(process.env["HTTPS_PROXY"]).toBe("http://upper-https.example.com:8080");
    expect(process.env["ALL_PROXY"]).toBe("http://upper-all.example.com:8080");
    expect(process.env["all_proxy"]).toBe("http://lower-all.example.com:8080");
    expect(process.env["NO_PROXY"]).toBe("localhost");
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe("http://global-http.example.com:8080");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");
  });

  it("temporarily clears managed proxy env while restoring the original HTTP stack", async () => {
    const patchedHttpRequest = vi.fn() as unknown as typeof http.request;
    mockBootstrapGlobalAgent.mockImplementationOnce(() => {
      http.request = patchedHttpRequest;
      (global as Record<string, unknown>)["GLOBAL_AGENT"] = {
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
      };
    });

    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    process.env["ALL_PROXY"] = "http://inherited-all.example.com:8080";

    const during = dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(
      "ws://127.0.0.1:18789",
      () => ({
        httpRequest: http.request,
        httpProxy: process.env["HTTP_PROXY"],
        allProxy: process.env["ALL_PROXY"],
        proxyActive: process.env["OPENCLAW_PROXY_ACTIVE"],
      }),
    );

    expect(during).toEqual({
      httpRequest: originalHttpRequest,
      httpProxy: undefined,
      allProxy: undefined,
      proxyActive: undefined,
    });
    expect(http.request).toBe(patchedHttpRequest);
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["ALL_PROXY"]).toBe("http://inherited-all.example.com:8080");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");

    await stopProxy(handle);
  });

  it("kill restores env synchronously during hard process exit", async () => {
    process.env["NO_PROXY"] = "corp.example.com";
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(handle).not.toBeNull();
    handle?.kill("SIGTERM");

    expect(process.env["HTTP_PROXY"]).toBeUndefined();
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
  });

  it("stopProxy is a no-op when handle is null", async () => {
    await expect(stopProxy(null)).resolves.toBeUndefined();
  });
});
