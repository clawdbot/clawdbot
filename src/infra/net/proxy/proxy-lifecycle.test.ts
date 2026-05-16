import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  installGlobalProxyMock,
  proxylineRegisterBypassMock,
  proxylineStopMock,
  proxylineUnregisterBypassMock,
} = vi.hoisted(() => {
  const proxylineStopMock = vi.fn();
  const proxylineUnregisterBypassMock = vi.fn();
  const proxylineRegisterBypassMock = vi.fn(() => proxylineUnregisterBypassMock);
  return {
    proxylineRegisterBypassMock,
    proxylineStopMock,
    proxylineUnregisterBypassMock,
    installGlobalProxyMock: vi.fn(() => ({
      active: true,
      createNodeAgent: vi.fn(),
      createUndiciDispatcher: vi.fn(),
      createWebSocketAgent: vi.fn(),
      explain: vi.fn(),
      mode: "managed",
      registerBypass: proxylineRegisterBypassMock,
      stop: proxylineStopMock,
      withBypass: vi.fn(),
    })),
  };
});
const forceResetGlobalDispatcherMock = vi.hoisted(() => vi.fn());

vi.mock("@openclaw/proxyline", () => ({
  installGlobalProxy: installGlobalProxyMock,
}));

vi.mock("../undici-global-dispatcher.js", () => ({
  forceResetGlobalDispatcher: forceResetGlobalDispatcherMock,
}));

vi.mock("../../../logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { logInfo, logWarn } from "../../../logger.js";
import { _resetActiveManagedProxyStateForTests } from "./active-proxy-state.js";
import {
  ensureInheritedManagedProxyRoutingActive,
  resetProxyLifecycleForTests,
  registerManagedProxyGatewayLoopbackBypass,
  startProxy,
  stopProxy,
  type ProxyHandle,
} from "./proxy-lifecycle.js";

const mockLogInfo = vi.mocked(logInfo);
const mockLogWarn = vi.mocked(logWarn);

function expectProxyHandle(handle: Awaited<ReturnType<typeof startProxy>>): ProxyHandle {
  if (handle === null) {
    throw new Error("Expected managed proxy handle");
  }
  expect(handle.proxyUrl).not.toBe("");
  return handle;
}

function expectBypassUnregister(
  unregister: ReturnType<typeof registerManagedProxyGatewayLoopbackBypass>,
): () => void {
  expect(unregister).toBeTypeOf("function");
  if (typeof unregister !== "function") {
    throw new Error("Expected Gateway bypass unregister callback");
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
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_LOOPBACK_MODE",
    "OPENCLAW_PROXY_URL",
  ];

  beforeEach(() => {
    for (const key of envKeysToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockLogInfo.mockReset();
    mockLogWarn.mockReset();
    resetProxyLifecycleForTests();
    _resetActiveManagedProxyStateForTests();
    installGlobalProxyMock.mockClear();
    proxylineRegisterBypassMock.mockClear();
    proxylineStopMock.mockClear();
    proxylineUnregisterBypassMock.mockClear();
    forceResetGlobalDispatcherMock.mockClear();
  });

  afterEach(() => {
    for (const key of envKeysToClean) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("returns null silently and does not touch env when not explicitly enabled", async () => {
    const handle = await startProxy(undefined);

    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(installGlobalProxyMock).not.toHaveBeenCalled();
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

  it("sets process proxy env vars for inherited clients", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expectProxyHandle(handle);
    expect(process.env["http_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["https_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
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

    await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(process.env["no_proxy"]).toBe("");
    expect(process.env["NO_PROXY"]).toBe("");
  });

  it("installs and stops Proxyline managed routing", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(installGlobalProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ifActive: "replace",
        mode: "managed",
        proxyUrl: "http://127.0.0.1:3128",
        undici: expect.objectContaining({ allowH2: false }),
      }),
    );
    expect(forceResetGlobalDispatcherMock).toHaveBeenCalledWith({
      preserveProxylineManaged: true,
    });

    await stopProxy(expectProxyHandle(handle));

    expect(proxylineStopMock).toHaveBeenCalledOnce();
    expect(forceResetGlobalDispatcherMock).toHaveBeenCalledTimes(2);
  });

  it("reuses inherited Proxyline routing and replaces it when startProxy takes ownership", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = "gateway-only";
    process.env["HTTP_PROXY"] = "http://127.0.0.1:3111";

    ensureInheritedManagedProxyRoutingActive();

    expect(installGlobalProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ifActive: "reuse-compatible",
        mode: "managed",
        proxyUrl: "http://127.0.0.1:3111",
        undici: expect.objectContaining({ allowH2: false }),
      }),
    );
    expect(proxylineStopMock).not.toHaveBeenCalled();

    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3222",
    });

    expect(installGlobalProxyMock).toHaveBeenCalledTimes(2);
    const installCalls = installGlobalProxyMock.mock.calls as unknown[][];
    expect(installCalls[1]?.[0]).toEqual(
      expect.objectContaining({
        ifActive: "replace",
        mode: "managed",
        proxyUrl: "http://127.0.0.1:3222",
        undici: expect.objectContaining({ allowH2: false }),
      }),
    );
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3222");

    await stopProxy(expectProxyHandle(handle));

    expect(proxylineStopMock).toHaveBeenCalledOnce();
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3111");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");
    expect(installGlobalProxyMock).toHaveBeenCalledTimes(3);
    expect(installCalls[2]?.[0]).toEqual(
      expect.objectContaining({
        ifActive: "reuse-compatible",
        mode: "managed",
        proxyUrl: "http://127.0.0.1:3111",
        undici: expect.objectContaining({ allowH2: false }),
      }),
    );
  });

  it("forces root undici onto the inherited managed proxy", () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = "gateway-only";
    process.env["HTTP_PROXY"] = "http://127.0.0.1:3111";

    ensureInheritedManagedProxyRoutingActive();

    expect(installGlobalProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ifActive: "reuse-compatible",
        mode: "managed",
        proxyUrl: "http://127.0.0.1:3111",
        undici: expect.objectContaining({ allowH2: false }),
      }),
    );
    expect(forceResetGlobalDispatcherMock).toHaveBeenCalledWith({
      preserveProxylineManaged: true,
    });
  });

  it("restores previous proxy env and stops Proxyline on stop", async () => {
    process.env["HTTP_PROXY"] = "http://previous.example.com:8080";
    process.env["NO_PROXY"] = "corp.example.com";

    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    const proxyHandle = expectProxyHandle(handle);
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["NO_PROXY"]).toBe("");

    await stopProxy(proxyHandle);

    expect(process.env["HTTP_PROXY"]).toBe("http://previous.example.com:8080");
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBeUndefined();
    expect(proxylineStopMock).toHaveBeenCalledOnce();
    expect(forceResetGlobalDispatcherMock).toHaveBeenCalledTimes(2);
  });

  it("keeps same-url overlapping handles active until the final stop", async () => {
    const firstHandle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    const secondHandle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(installGlobalProxyMock).toHaveBeenCalledOnce();
    expect(forceResetGlobalDispatcherMock).toHaveBeenCalledOnce();
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");

    await stopProxy(secondHandle);

    expect(proxylineStopMock).not.toHaveBeenCalled();
    expect(forceResetGlobalDispatcherMock).toHaveBeenCalledOnce();
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBe("1");

    await stopProxy(firstHandle);

    expect(proxylineStopMock).toHaveBeenCalledOnce();
    expect(forceResetGlobalDispatcherMock).toHaveBeenCalledTimes(2);
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

  it("restores env and throws when Proxyline activation fails", async () => {
    installGlobalProxyMock.mockImplementationOnce(() => {
      throw new Error("install failed");
    });

    await expect(
      startProxy({
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      }),
    ).rejects.toThrow("failed to activate external proxy routing");

    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["OPENCLAW_PROXY_ACTIVE"]).toBeUndefined();
  });

  it("registers exact Gateway loopback URLs with Proxyline", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    const unregister = expectBypassUnregister(
      registerManagedProxyGatewayLoopbackBypass("ws://127.0.0.1:18789"),
    );
    expect(proxylineRegisterBypassMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
    });

    unregister();
    expect(proxylineUnregisterBypassMock).toHaveBeenCalledOnce();
    await stopProxy(handle);
  });

  it("delegates overlapping Gateway loopback bypass registrations to Proxyline", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    const unregisterFirst = expectBypassUnregister(
      registerManagedProxyGatewayLoopbackBypass("ws://127.0.0.1:18789"),
    );
    const unregisterSecond = expectBypassUnregister(
      registerManagedProxyGatewayLoopbackBypass("ws://127.0.0.1:18789"),
    );

    expect(proxylineRegisterBypassMock).toHaveBeenCalledTimes(2);
    expect(proxylineRegisterBypassMock).toHaveBeenNthCalledWith(1, {
      url: "ws://127.0.0.1:18789",
    });
    expect(proxylineRegisterBypassMock).toHaveBeenNthCalledWith(2, {
      url: "ws://127.0.0.1:18789",
    });
    unregisterFirst();
    expect(proxylineUnregisterBypassMock).toHaveBeenCalledTimes(1);
    unregisterSecond();
    expect(proxylineUnregisterBypassMock).toHaveBeenCalledTimes(2);

    await stopProxy(handle);
  });

  it("accepts literal loopback IPs and localhost for Gateway bypass registration", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    const unregisterIpv6 = expectBypassUnregister(
      registerManagedProxyGatewayLoopbackBypass("ws://[::1]:18789"),
    );
    expect(proxylineRegisterBypassMock).toHaveBeenCalledWith({ url: "ws://[::1]:18789" });
    unregisterIpv6();

    const unregisterLocalhost = expectBypassUnregister(
      registerManagedProxyGatewayLoopbackBypass("ws://localhost.:18789"),
    );
    expect(proxylineRegisterBypassMock).toHaveBeenCalledWith({ url: "ws://localhost.:18789" });
    unregisterLocalhost();

    await stopProxy(handle);
  });

  it("does not register Gateway bypass for non-loopback URLs", () => {
    expect(registerManagedProxyGatewayLoopbackBypass("wss://gateway.example.com")).toBeUndefined();
  });

  it("allows Gateway bypass registration for custom configured loopback ports", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    const unregister = expectBypassUnregister(
      registerManagedProxyGatewayLoopbackBypass("ws://127.0.0.1:3000"),
    );
    expect(proxylineRegisterBypassMock).toHaveBeenCalledWith({ url: "ws://127.0.0.1:3000" });

    unregister();
    await stopProxy(handle);
  });

  it("blocks Gateway bypass registration when active proxy loopbackMode is block", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "block",
    });

    try {
      expect(() => registerManagedProxyGatewayLoopbackBypass("ws://127.0.0.1:18789")).toThrow(
        "blocked by proxy.loopbackMode",
      );
    } finally {
      await stopProxy(handle);
    }
  });

  it("does not register Gateway bypass when active proxy loopbackMode is proxy", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "proxy",
    });

    try {
      const unregister = registerManagedProxyGatewayLoopbackBypass("ws://127.0.0.1:18789");
      expect(proxylineRegisterBypassMock).not.toHaveBeenCalled();
      expect(unregister).toBeUndefined();
    } finally {
      await stopProxy(handle);
    }
  });

  it("does not mutate NO_PROXY while registering Gateway bypass", async () => {
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    process.env["NO_PROXY"] = "corp.example.com";
    process.env["no_proxy"] = "corp.example.com";

    const unregister = expectBypassUnregister(
      registerManagedProxyGatewayLoopbackBypass("ws://127.0.0.1:18789"),
    );
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
    expect(process.env["no_proxy"]).toBe("corp.example.com");

    unregister();
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
    expect(process.env["no_proxy"]).toBe("corp.example.com");
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
