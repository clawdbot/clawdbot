import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  setCurrentDispatcher,
  getCurrentDispatcher,
  getDefaultAutoSelectFamily,
} = vi.hoisted(() => {
  class Agent {
    constructor(public readonly options?: Record<string, unknown>) {}
  }

  class EnvHttpProxyAgent {
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

  return {
    Agent,
    EnvHttpProxyAgent,
    ProxyAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
    setCurrentDispatcher,
    getCurrentDispatcher,
    getDefaultAutoSelectFamily,
  };
});

const mockedModuleIds = ["node:net", "undici", "./proxy-env.js", "../wsl.js"] as const;

vi.mock("undici", () => ({
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
}));

vi.mock("node:net", () => ({
  getDefaultAutoSelectFamily,
}));

vi.mock("./proxy-env.js", () => ({
  hasEnvHttpProxyConfigured: vi.fn(() => false),
}));

vi.mock("../wsl.js", () => ({
  isWSL2Sync: vi.fn(() => false),
}));

import { isWSL2Sync } from "../wsl.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";
let DEFAULT_UNDICI_STREAM_TIMEOUT_MS: typeof import("./undici-global-dispatcher.js").DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
let ensureGlobalUndiciEnvProxyDispatcher: typeof import("./undici-global-dispatcher.js").ensureGlobalUndiciEnvProxyDispatcher;
let ensureGlobalUndiciStreamTimeouts: typeof import("./undici-global-dispatcher.js").ensureGlobalUndiciStreamTimeouts;
let resetGlobalUndiciStreamTimeoutsForTests: typeof import("./undici-global-dispatcher.js").resetGlobalUndiciStreamTimeoutsForTests;
let undiciGlobalDispatcherModule: typeof import("./undici-global-dispatcher.js");

describe("ensureGlobalUndiciStreamTimeouts", () => {
  beforeAll(async () => {
    undiciGlobalDispatcherModule = await import("./undici-global-dispatcher.js");
    ({
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
      ensureGlobalUndiciEnvProxyDispatcher,
      ensureGlobalUndiciStreamTimeouts,
      resetGlobalUndiciStreamTimeoutsForTests,
    } = undiciGlobalDispatcherModule);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    getDefaultAutoSelectFamily.mockReturnValue(undefined);
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(false);
  });

  it("replaces default Agent dispatcher with extended stream timeouts", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(Agent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("replaces EnvHttpProxyAgent dispatcher while preserving env-proxy mode", () => {
    getDefaultAutoSelectFamily.mockReturnValue(false);
    setCurrentDispatcher(new EnvHttpProxyAgent());

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("records timeout bridge but does not override unsupported custom proxy dispatcher types", () => {
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(undiciGlobalDispatcherModule._globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("is idempotent for unchanged dispatcher kind and network policy", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts();
    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("does not lower global stream timeouts below the default floor", () => {
    ensureGlobalUndiciStreamTimeouts({ timeoutMs: 15_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
  });

  it("honors explicit global stream timeouts above the default floor", () => {
    const timeoutMs = DEFAULT_UNDICI_STREAM_TIMEOUT_MS + 1_000;

    ensureGlobalUndiciStreamTimeouts({ timeoutMs });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next.options?.bodyTimeout).toBe(timeoutMs);
    expect(next.options?.headersTimeout).toBe(timeoutMs);
  });

  it("re-applies when autoSelectFamily decision changes", () => {
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

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(Agent);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });
});

describe("ensureGlobalUndiciEnvProxyDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(false);
  });

  it("installs EnvHttpProxyAgent when env HTTP proxy is configured on a default Agent", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("does not override unsupported custom proxy dispatcher types", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("retries proxy bootstrap after an unsupported dispatcher later becomes a default Agent", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();

    setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("is idempotent after proxy bootstrap succeeds", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("reinstalls env proxy if an external change later reverts the dispatcher to Agent", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
});
