import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execNodeEvalSync } from "../../test-utils/node-process.js";

const {
  Agent,
  EnvHttpProxyAgent,
  ManagedUndiciDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
  setCurrentDispatcher,
  getCurrentDispatcher,
  getDefaultAutoSelectFamily,
  setDefaultAutoSelectFamily,
  isProxylineDispatcher,
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
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

  class ManagedUndiciDispatcher {
    #closed = false;
    #destroyed = false;
    public readonly dispatchCalls: Array<Record<string, unknown>> = [];
    public readonly requestCalls: Array<Record<string, unknown>> = [];
    constructor(public readonly options?: Record<string, unknown>) {}
    get closed(): boolean {
      return this.#closed;
    }
    get destroyed(): boolean {
      return this.#destroyed;
    }
    dispatch(options: Record<string, unknown>): boolean {
      this.dispatchCalls.push(options);
      return true;
    }
    request(options: Record<string, unknown>): boolean {
      this.requestCalls.push(options);
      return this.dispatch({ ...options, fromRequest: true });
    }
    on(): this {
      return this;
    }
    close(): void {
      this.#closed = true;
    }
    destroy(): void {
      this.#destroyed = true;
    }
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
  const setDefaultAutoSelectFamily = vi.fn();
  const isProxylineDispatcher = vi.fn(
    (dispatcher: unknown) => dispatcher instanceof ManagedUndiciDispatcher,
  );
  const createHttp1Agent = vi.fn(
    (options?: Record<string, unknown>, timeoutMs?: number) =>
      new Agent({
        ...options,
        ...(timeoutMs ? { bodyTimeout: timeoutMs, headersTimeout: timeoutMs } : {}),
        allowH2: false,
      }),
  );
  const createHttp1EnvHttpProxyAgent = vi.fn(
    (options?: Record<string, unknown>, timeoutMs?: number) =>
      new EnvHttpProxyAgent({
        ...options,
        ...(timeoutMs ? { bodyTimeout: timeoutMs, headersTimeout: timeoutMs } : {}),
        allowH2: false,
        clientFactory: "ip-safe-test-client-factory",
      }),
  );
  const loadUndiciGlobalDispatcherDeps = vi.fn(() => ({
    Agent,
    EnvHttpProxyAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
  }));

  return {
    Agent,
    EnvHttpProxyAgent,
    ManagedUndiciDispatcher,
    ProxyAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
    setCurrentDispatcher,
    getCurrentDispatcher,
    getDefaultAutoSelectFamily,
    isProxylineDispatcher,
    createHttp1Agent,
    createHttp1EnvHttpProxyAgent,
    setDefaultAutoSelectFamily,
    loadUndiciGlobalDispatcherDeps,
  };
});

const mockedModuleIds = [
  "@openclaw/proxyline/dispatcher-brand",
  "node:net",
  "./proxy-env.js",
  "./undici-runtime.js",
  "../wsl.js",
] as const;

vi.mock("@openclaw/proxyline/dispatcher-brand", () => ({
  isProxylineDispatcher,
}));

vi.mock("node:net", () => ({
  getDefaultAutoSelectFamily,
  setDefaultAutoSelectFamily,
}));

vi.mock("./proxy-env.js", () => ({
  hasEnvHttpProxyAgentConfigured: vi.fn(() => false),
  resolveEnvHttpProxyAgentOptions: vi.fn(() => undefined),
  resolveEnvHttpProxyUrl: vi.fn(() => undefined),
}));

vi.mock("./undici-runtime.js", () => ({
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  loadUndiciGlobalDispatcherDeps,
}));

vi.mock("../wsl.js", () => ({
  isWSL2Sync: vi.fn(() => false),
}));

import { isWSL2Sync } from "../wsl.js";
import {
  hasEnvHttpProxyAgentConfigured,
  resolveEnvHttpProxyAgentOptions,
  resolveEnvHttpProxyUrl,
} from "./proxy-env.js";
import {
  _resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";
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
    _resetActiveManagedProxyStateForTests();
    setCurrentDispatcher(new Agent());
    getDefaultAutoSelectFamily.mockReturnValue(undefined);
    vi.mocked(isWSL2Sync).mockReturnValue(false);
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(false);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
    vi.mocked(resolveEnvHttpProxyUrl).mockReturnValue(undefined);
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

    const output = execNodeEvalSync(source, { env, imports: ["tsx"] });

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

  it("adds active managed proxy CA trust when replacing EnvHttpProxyAgent dispatcher", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "https://proxy.example:8443",
      httpsProxy: "https://proxy.example:8443",
    });
    const registration = registerActiveManagedProxyUrl(new URL("https://proxy.example:8443"), {
      proxyTls: { ca: "dispatcher-ca" },
    });
    setCurrentDispatcher(new EnvHttpProxyAgent());

    try {
      ensureGlobalUndiciStreamTimeouts();

      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
      const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
      expect(next).toBeInstanceOf(EnvHttpProxyAgent);
      expect(next.options).toEqual(
        expect.objectContaining({
          httpProxy: "https://proxy.example:8443",
          httpsProxy: "https://proxy.example:8443",
          proxyTls: expect.objectContaining({ ca: "dispatcher-ca" }),
        }),
      );
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  it("records timeout bridge but does not override unsupported custom proxy dispatcher types", () => {
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(undiciGlobalDispatcherModule._globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("wraps Proxyline managed dispatcher with timed dispatch options", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as {
      constructor?: { name?: string };
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
      on: () => unknown;
      request: (options: Record<string, unknown>) => boolean;
      close: () => void;
      destroy: () => void;
    };
    expect(next).not.toBe(dispatcher);
    expect(next.constructor?.name).toBe("ManagedUndiciDispatcher");
    expect(next.on()).toBe(next);
    next.close();
    next.destroy();
    expect(dispatcher.closed).toBe(true);
    expect(dispatcher.destroyed).toBe(true);
    expect(next.request({ origin: "https://request.example.test", path: "/", method: "GET" })).toBe(
      true,
    );
    expect(next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {})).toBe(
      true,
    );
    expect(dispatcher.requestCalls).toEqual([
      {
        origin: "https://request.example.test",
        path: "/",
        method: "GET",
      },
    ]);
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://request.example.test",
        path: "/",
        method: "GET",
        fromRequest: true,
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
    ]);
    expect(undiciGlobalDispatcherModule._globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("replaces a fresh Proxyline managed dispatcher after env proxy timeouts were applied", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://proxyline.example:3128",
      httpsProxy: "http://proxyline.example:3128",
    });
    setCurrentDispatcher(new EnvHttpProxyAgent());
    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);
    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const next = getCurrentDispatcher() as {
      constructor?: { name?: string };
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    expect(next.constructor?.name).toBe("ManagedUndiciDispatcher");
    next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {});
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
    ]);
  });

  it("updates an existing Proxyline timeout wrapper when run timeout changes", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });
    const wrapped = getCurrentDispatcher();
    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 2_100_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(getCurrentDispatcher()).toBe(wrapped);
    const next = getCurrentDispatcher() as {
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {});
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 2_100_000,
        headersTimeout: 2_100_000,
        allowH2: false,
      },
    ]);
  });

  it("wraps a replaced raw Proxyline dispatcher when timeout policy is unchanged", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ManagedUndiciDispatcher());
    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    const replacement = new ManagedUndiciDispatcher();
    setCurrentDispatcher(replacement);
    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const next = getCurrentDispatcher() as {
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {});
    expect(replacement.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
    ]);
  });

  it("preserves concrete dispatch timeouts through the Proxyline timeout wrapper", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    const next = getCurrentDispatcher() as {
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    next.dispatch(
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 12_000,
        headersTimeout: 0,
      },
      {},
    );
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 12_000,
        headersTimeout: 0,
        allowH2: false,
      },
    ]);
  });

  it("fills null dispatch timeouts through the Proxyline timeout wrapper", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    const next = getCurrentDispatcher() as {
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    next.dispatch(
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: null,
        headersTimeout: null,
      },
      {},
    );
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
    ]);
  });

  it("temporarily applies the WSL2 family-selection policy around Proxyline dispatch", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);
    vi.mocked(isWSL2Sync).mockReturnValue(true);
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    const next = getCurrentDispatcher() as {
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {});
    expect(setDefaultAutoSelectFamily).toHaveBeenNthCalledWith(1, false);
    expect(setDefaultAutoSelectFamily).toHaveBeenNthCalledWith(2, true);
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
    ]);
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
    _resetActiveManagedProxyStateForTests();
    setCurrentDispatcher(new Agent());
    vi.mocked(isWSL2Sync).mockReturnValue(false);
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(false);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
    vi.mocked(resolveEnvHttpProxyUrl).mockReturnValue(undefined);
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
      clientFactory: "ip-safe-test-client-factory",
    });
  });

  it("installs EnvHttpProxyAgent with active managed proxy CA trust", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "https://proxy.example:8443",
      httpsProxy: "https://proxy.example:8443",
    });
    const registration = registerActiveManagedProxyUrl(new URL("https://proxy.example:8443"), {
      proxyTls: { ca: "bootstrap-ca" },
    });

    try {
      ensureGlobalUndiciEnvProxyDispatcher();

      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
      const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
      expect(next).toBeInstanceOf(EnvHttpProxyAgent);
      expect(next.options).toEqual({
        httpProxy: "https://proxy.example:8443",
        httpsProxy: "https://proxy.example:8443",
        proxyTls: { ca: "bootstrap-ca" },
        allowH2: false,
        clientFactory: "ip-safe-test-client-factory",
      });
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  it("does not override unsupported custom proxy dispatcher types", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("treats Proxyline managed dispatchers as already proxy-backed during bootstrap", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ManagedUndiciDispatcher());

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

  it("reinstalls env proxy when resolved proxy options change", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://old-proxy.example:3128",
      httpsProxy: "http://old-proxy.example:3128",
    });

    ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://new-proxy.example:3128",
      httpsProxy: "http://new-proxy.example:3128",
    });
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect((getCurrentDispatcher() as { options?: Record<string, unknown> }).options).toEqual({
      httpProxy: "http://new-proxy.example:3128",
      httpsProxy: "http://new-proxy.example:3128",
      allowH2: false,
      clientFactory: "ip-safe-test-client-factory",
    });
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
    vi.mocked(resolveEnvHttpProxyUrl).mockReturnValue(undefined);
    vi.mocked(isWSL2Sync).mockReturnValue(false);
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
    expect((getCurrentDispatcher() as { options?: Record<string, unknown> }).options).toEqual({
      allowH2: false,
    });
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
      clientFactory: "ip-safe-test-client-factory",
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
      clientFactory: "ip-safe-test-client-factory",
    });
  });

  it("preserves Proxyline managed dispatcher when requested", () => {
    vi.mocked(hasEnvHttpProxyAgentConfigured).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://proxy-a.example:8080",
      httpsProxy: "http://proxy-a.example:8080",
    });
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    forceResetGlobalDispatcher({ preserveProxylineManaged: true });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(getCurrentDispatcher()).toBe(dispatcher);
  });
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
});
