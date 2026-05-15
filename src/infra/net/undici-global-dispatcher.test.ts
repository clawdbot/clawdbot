import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  setGlobalDispatcher,
  setCurrentDispatcher,
  getCurrentDispatcher,
  getDefaultAutoSelectFamily,
  loadUndiciGlobalDispatcherDeps,
} = vi.hoisted(() => {
  class Agent {
    constructor(public readonly options?: Record<string, unknown>) {}
  }

  class EnvHttpProxyAgent {
    public readonly capturedHttpProxy = process.env.HTTP_PROXY;
    constructor(public readonly options?: Record<string, unknown>) {}
  }

  class ProxyAgent {
    constructor(public readonly url: string) {}
  }

  let currentDispatcher: unknown = new Agent();

  const getGlobalDispatcher = vi.fn(() => currentDispatcher);
  const setGlobalDispatcher = vi.fn((next: unknown) => {
    currentDispatcher = next;
  });
  const setCurrentDispatcher = (next: unknown) => {
    currentDispatcher = next;
  };
  const getCurrentDispatcher = () => currentDispatcher;
  const getDefaultAutoSelectFamily = vi.fn(() => undefined as boolean | undefined);
  const loadUndiciGlobalDispatcherDeps = vi.fn(() => ({
    Agent,
    EnvHttpProxyAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
  }));

  return {
    Agent,
    EnvHttpProxyAgent,
    ProxyAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
    setCurrentDispatcher,
    getCurrentDispatcher,
    getDefaultAutoSelectFamily,
    loadUndiciGlobalDispatcherDeps,
  };
});

const mockedModuleIds = ["node:net", "./proxy-env.js", "./undici-runtime.js", "../wsl.js"] as const;

vi.mock("node:net", () => ({
  getDefaultAutoSelectFamily,
}));

vi.mock("./proxy-env.js", () => ({
  hasEnvHttpProxyAgentConfigured: vi.fn(() => false),
  resolveEnvHttpProxyAgentOptions: vi.fn(() => undefined),
}));

vi.mock("./undici-runtime.js", () => ({
  loadUndiciGlobalDispatcherDeps,
}));

vi.mock("../wsl.js", () => ({
  isWSL2Sync: vi.fn(() => false),
}));

import { isWSL2Sync } from "../wsl.js";
import { hasEnvHttpProxyAgentConfigured, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
let DEFAULT_UNDICI_STREAM_TIMEOUT_MS: typeof import("./undici-global-dispatcher.js").DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
let ensureGlobalUndiciDispatcherStreamTimeouts: typeof import("./undici-global-dispatcher.js").ensureGlobalUndiciDispatcherStreamTimeouts;
let ensureGlobalUndiciEnvProxyDispatcher: typeof import("./undici-global-dispatcher.js").ensureGlobalUndiciEnvProxyDispatcher;
let ensureGlobalUndiciStreamTimeouts: typeof import("./undici-global-dispatcher.js").ensureGlobalUndiciStreamTimeouts;
let forceResetGlobalDispatcher: typeof import("./undici-global-dispatcher.js").forceResetGlobalDispatcher;
let resetGlobalUndiciStreamTimeoutsForTests: typeof import("./undici-global-dispatcher.js").resetGlobalUndiciStreamTimeoutsForTests;
let undiciGlobalDispatcherModule: typeof import("./undici-global-dispatcher.js");

describe("ensureGlobalUndiciStreamTimeouts", () => {
  beforeAll(async () => {
    undiciGlobalDispatcherModule = await import("./undici-global-dispatcher.js");
    ({
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
      ensureGlobalUndiciDispatcherStreamTimeouts,
      ensureGlobalUndiciEnvProxyDispatcher,
      ensureGlobalUndiciStreamTimeouts,
      forceResetGlobalDispatcher,
      resetGlobalUndiciStreamTimeoutsForTests,
    } = undiciGlobalDispatcherModule);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    getDefaultAutoSelectFamily.mockReturnValue(undefined);
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(false);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
  });

  it("records timeout bridge without importing undici when no env proxy is configured", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts();

    expect(loadUndiciGlobalDispatcherDeps).not.toHaveBeenCalled();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(undiciGlobalDispatcherModule._globalUndiciStreamTimeoutMs).toBe(
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
    );
  });

  it("does not initialize the undici global dispatcher in a no-proxy subprocess", () => {
    const moduleUrl = pathToFileURL(path.resolve("src/infra/net/undici-global-dispatcher.ts")).href;
    const source = `
      const dispatcherKey = Symbol.for("undici.globalDispatcher.1");
      const mod = await import(${JSON.stringify(moduleUrl)});
      mod.ensureGlobalUndiciStreamTimeouts({ timeoutMs: 1_900_000 });
      if (globalThis[dispatcherKey] !== undefined) {
        throw new Error("undici global dispatcher was initialized");
      }
      console.log("ok");
    `;
    const env = { ...process.env };
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      delete env[key];
    }

    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      { cwd: process.cwd(), encoding: "utf8", env },
    );

    expect(output.trim()).toBe("ok");
  });

  it("explicitly tunes the global dispatcher when requested for embedded attempts", () => {
    getDefaultAutoSelectFamily.mockReturnValue(false);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(loadUndiciGlobalDispatcherDeps).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(Agent);
    expect(next.options).toEqual({
      bodyTimeout: 1_900_000,
      headersTimeout: 1_900_000,
      allowH2: false,
      connect: {
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 300,
      },
    });
    expect(undiciGlobalDispatcherModule._globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("replaces EnvHttpProxyAgent dispatcher while preserving env-proxy mode", () => {
    getDefaultAutoSelectFamily.mockReturnValue(false);
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new EnvHttpProxyAgent());

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.allowH2).toBe(false);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("preserves explicit env proxy options when replacing EnvHttpProxyAgent dispatcher", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "socks5://proxy.test:1080",
      httpsProxy: "socks5://proxy.test:1080",
    });
    setCurrentDispatcher(new EnvHttpProxyAgent());

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.httpProxy).toBe("socks5://proxy.test:1080");
    expect(next.options?.httpsProxy).toBe("socks5://proxy.test:1080");
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.allowH2).toBe(false);
  });

  it("records timeout bridge but does not override unsupported custom proxy dispatcher types", () => {
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(undiciGlobalDispatcherModule._globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("is idempotent for unchanged dispatcher kind and network policy", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new EnvHttpProxyAgent());

    ensureGlobalUndiciStreamTimeouts();
    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("does not lower global stream timeouts below the default floor", () => {
    ensureGlobalUndiciStreamTimeouts({ timeoutMs: 15_000 });

    expect(loadUndiciGlobalDispatcherDeps).not.toHaveBeenCalled();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(undiciGlobalDispatcherModule._globalUndiciStreamTimeoutMs).toBe(
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
    );
  });

  it("honors explicit global stream timeouts above the default floor", () => {
    const timeoutMs = DEFAULT_UNDICI_STREAM_TIMEOUT_MS + 1_000;

    ensureGlobalUndiciStreamTimeouts({ timeoutMs });

    expect(loadUndiciGlobalDispatcherDeps).not.toHaveBeenCalled();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(undiciGlobalDispatcherModule._globalUndiciStreamTimeoutMs).toBe(timeoutMs);
  });

  it("re-applies when autoSelectFamily decision changes", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new EnvHttpProxyAgent());
    getDefaultAutoSelectFamily.mockReturnValue(true);
    ensureGlobalUndiciStreamTimeouts();

    getDefaultAutoSelectFamily.mockReturnValue(false);
    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("disables autoSelectFamily on WSL2 to avoid IPv6 connectivity issues", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);
    vi.mocked(isWSL2Sync).mockReturnValue(true);
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new EnvHttpProxyAgent());

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
    expect(next.options?.allowH2).toBe(false);
  });
});

describe("ensureGlobalUndiciEnvProxyDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(false);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
  });

  it("installs EnvHttpProxyAgent when env HTTP proxy is configured on a default Agent", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.allowH2).toBe(false);
  });

  it("installs EnvHttpProxyAgent with explicit ALL_PROXY fallback options", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "socks5://proxy.test:1080",
      httpsProxy: "socks5://proxy.test:1080",
    });

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options).toEqual({
      httpProxy: "socks5://proxy.test:1080",
      httpsProxy: "socks5://proxy.test:1080",
      allowH2: false,
    });
  });

  it("does not override unsupported custom proxy dispatcher types", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("retries proxy bootstrap after an unsupported dispatcher later becomes a default Agent", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();

    setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("is idempotent after proxy bootstrap succeeds", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("reinstalls env proxy if an external change later reverts the dispatcher to Agent", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });
});

describe("forceResetGlobalDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(false);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
  });

  it("does not import undici when proxy env is cleared", () => {
    setCurrentDispatcher(new EnvHttpProxyAgent());

    forceResetGlobalDispatcher();

    expect(loadUndiciGlobalDispatcherDeps).not.toHaveBeenCalled();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("restores a direct Agent when clearing a proxy dispatcher installed by OpenClaw", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    ensureGlobalUndiciEnvProxyDispatcher();
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);

    vi.clearAllMocks();
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(false);

    forceResetGlobalDispatcher();

    expect(loadUndiciGlobalDispatcherDeps).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(Agent);
  });

  it("replaces a stale EnvHttpProxyAgent when restored proxy env is still configured", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://proxy-b.example:8080",
      httpsProxy: "http://proxy-b.example:8080",
    });
    setCurrentDispatcher(new EnvHttpProxyAgent());

    forceResetGlobalDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    expect((getCurrentDispatcher() as { options?: Record<string, unknown> }).options).toEqual({
      httpProxy: "http://proxy-b.example:8080",
      httpsProxy: "http://proxy-b.example:8080",
      allowH2: false,
    });
  });

  it("preserves ALL_PROXY-only EnvHttpProxyAgent options when resetting", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://proxy-all.example:3128",
      httpsProxy: "http://proxy-all.example:3128",
    });
    setCurrentDispatcher(new EnvHttpProxyAgent());

    forceResetGlobalDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    expect((getCurrentDispatcher() as { options?: Record<string, unknown> }).options).toEqual({
      httpProxy: "http://proxy-all.example:3128",
      httpsProxy: "http://proxy-all.example:3128",
      allowH2: false,
    });
  });
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
});
