import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "./undici-runtime.js";

const { agentCtor, envHttpProxyAgentCtor, proxyAgentCtor } = vi.hoisted(() => ({
  agentCtor: vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
  envHttpProxyAgentCtor: vi.fn(function MockEnvHttpProxyAgent(
    this: { options: unknown },
    options: unknown,
  ) {
    this.options = options;
  }),
  proxyAgentCtor: vi.fn(function MockProxyAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));

const { getDefaultAutoSelectFamily, isWSL2SyncMock } = vi.hoisted(() => ({
  getDefaultAutoSelectFamily: vi.fn(() => true as boolean | undefined),
  isWSL2SyncMock: vi.fn(() => false),
}));

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  getDefaultAutoSelectFamily,
}));

vi.mock("../wsl.js", () => ({
  isWSL2Sync: isWSL2SyncMock,
}));

import type { PinnedHostname } from "./ssrf.js";

let createPinnedDispatcher: typeof import("./ssrf.js").createPinnedDispatcher;

beforeAll(async () => {
  ({ createPinnedDispatcher } = await import("./ssrf.js"));
});

beforeEach(() => {
  agentCtor.mockClear();
  envHttpProxyAgentCtor.mockClear();
  proxyAgentCtor.mockClear();
  getDefaultAutoSelectFamily.mockReturnValue(true);
  isWSL2SyncMock.mockReturnValue(false);
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: agentCtor,
    EnvHttpProxyAgent: envHttpProxyAgentCtor,
    ProxyAgent: proxyAgentCtor,
    fetch: vi.fn(),
  };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

function createPinnedTelegramHost(lookup: PinnedHostname["lookup"]): PinnedHostname {
  return {
    hostname: "api.telegram.org",
    addresses: ["149.154.167.221"],
    lookup,
  };
}

function createDispatcherWithPinnedOverride(lookup: PinnedHostname["lookup"]) {
  createPinnedDispatcher(createPinnedTelegramHost(lookup), {
    mode: "direct",
    pinnedHostname: {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
    },
  });

  const call = agentCtor.mock.calls[agentCtor.mock.calls.length - 1];
  return (call?.[0] as { connect?: { lookup?: PinnedHostname["lookup"] } })?.connect?.lookup;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireFirstAgentOptions(): Record<string, unknown> {
  const [call] = agentCtor.mock.calls;
  if (!call) {
    throw new Error("expected Agent constructor call");
  }
  return requireRecord(call[0], "Agent constructor options");
}

describe("createPinnedDispatcher", () => {
  it("uses pinned lookup and inherits the shared undici family policy", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    const dispatcher = createPinnedDispatcher(pinned);

    const dispatcherOptions = (
      dispatcher as {
        options?: { allowH2?: boolean; connect?: Record<string, unknown> };
      }
    ).options;
    expect(dispatcherOptions?.connect?.lookup).toBe(lookup);
    expect(dispatcherOptions?.connect?.autoSelectFamily).toBe(true);
    expect(dispatcherOptions?.connect?.autoSelectFamilyAttemptTimeout).toBe(300);
    expect(dispatcherOptions?.allowH2).toBe(false);
    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        lookup,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      },
      allowH2: false,
    });
    const firstCallArg = requireFirstAgentOptions();
    expect(requireRecord(firstCallArg.connect, "Agent connect options").autoSelectFamily).toBe(
      true,
    );
  });

  it("reuses the global WSL2 autoSelectFamily policy for pinned dispatchers", () => {
    isWSL2SyncMock.mockReturnValue(true);
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned);

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        lookup,
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 300,
      },
      allowH2: false,
    });
  });

  it("preserves caller transport hints while overriding lookup", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const previousLookup = vi.fn();
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, {
      mode: "direct",
      connect: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup: previousLookup,
      },
    });

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup,
      },
      allowH2: false,
    });
  });

  it("preserves explicit family-selection opt-outs", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, {
      mode: "direct",
      connect: {
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 50,
      },
    });

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 50,
        lookup,
      },
      allowH2: false,
    });
  });

  it("applies stream timeouts to pinned direct dispatchers", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, undefined, undefined, 123_456);

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        lookup,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        timeout: 123_456,
      },
      allowH2: false,
      bodyTimeout: 123_456,
      headersTimeout: 123_456,
    });
  });

  it("replaces the pinned lookup when a dispatcher override hostname is provided", () => {
    const originalLookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const lookup = createDispatcherWithPinnedOverride(originalLookup);

    expect(lookup).toBeTypeOf("function");
    const callback = vi.fn();
    lookup?.("api.telegram.org", callback);

    expect(callback).toHaveBeenCalledWith(null, "149.154.167.220", 4);
    expect(originalLookup).not.toHaveBeenCalled();
  });

  it("keeps the override bound to the matching hostname only", () => {
    const originalLookupMock = vi.fn(
      (_hostname: string, callback: (err: null, address: string, family: number) => void) => {
        callback(null, "93.184.216.34", 4);
      },
    );
    const originalLookup = originalLookupMock as unknown as PinnedHostname["lookup"];
    const lookup = createDispatcherWithPinnedOverride(originalLookup);
    const callback = vi.fn();
    lookup?.("example.com", callback);

    expect(originalLookupMock).toHaveBeenCalledWith("example.com", expect.any(Function));
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("rejects pinned override addresses that violate SSRF policy", () => {
    const originalLookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.221"],
      lookup: originalLookup,
    };

    expect(() =>
      createPinnedDispatcher(
        pinned,
        {
          mode: "direct",
          pinnedHostname: {
            hostname: "api.telegram.org",
            addresses: ["127.0.0.1"],
          },
        },
        undefined,
      ),
    ).toThrow(/private|internal|blocked/i);
  });

  it("keeps env proxy route while pinning the direct no-proxy path", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, {
      mode: "env-proxy",
      connect: {
        autoSelectFamily: true,
      },
      proxyTls: {
        autoSelectFamily: true,
      },
    });

    expect(envHttpProxyAgentCtor).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup,
      },
      allowH2: false,
      proxyTls: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      },
    });
  });

  it("keeps explicit proxy routing intact", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, {
      mode: "explicit-proxy",
      proxyUrl: "http://127.0.0.1:7890",
      proxyTls: {
        autoSelectFamily: false,
      },
    });

    expect(proxyAgentCtor).toHaveBeenCalledWith({
      uri: "http://127.0.0.1:7890",
      proxyTls: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      },
      allowH2: false,
      requestTls: {
        autoSelectFamily: false,
        lookup,
      },
    });
  });

  it("applies stream timeouts to explicit proxy dispatchers", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(
      pinned,
      {
        mode: "explicit-proxy",
        proxyUrl: "http://127.0.0.1:7890",
        proxyTls: {
          autoSelectFamily: false,
        },
      },
      undefined,
      654_321,
    );

    expect(proxyAgentCtor).toHaveBeenCalledWith({
      uri: "http://127.0.0.1:7890",
      requestTls: {
        autoSelectFamily: false,
        lookup,
      },
      proxyTls: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        timeout: 654_321,
      },
      allowH2: false,
      bodyTimeout: 654_321,
      headersTimeout: 654_321,
    });
  });
});
