import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setDefaultResultOrder = vi.hoisted(() => vi.fn());
const setDefaultAutoSelectFamily = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerDebug = vi.hoisted(() => vi.fn());

const undiciFetch = vi.hoisted(() => vi.fn());
const setGlobalDispatcher = vi.hoisted(() => vi.fn());
type MockDispatcherInstance = {
  options?: Record<string, unknown> | string;
  destroy: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(this: MockDispatcherInstance, options?: Record<string, unknown>) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
  }),
);
const EnvHttpProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockEnvHttpProxyAgent(
    this: MockDispatcherInstance,
    options?: Record<string, unknown>,
  ) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
  }),
);
const ProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockProxyAgent(
    this: MockDispatcherInstance,
    options?: Record<string, unknown> | string,
  ) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
  }),
);

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    setDefaultResultOrder,
  };
});

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    ...actual,
    setDefaultAutoSelectFamily,
  };
});

vi.mock("undici", () => ({
  Agent: AgentCtor,
  EnvHttpProxyAgent: EnvHttpProxyAgentCtor,
  ProxyAgent: ProxyAgentCtor,
  fetch: undiciFetch,
  setGlobalDispatcher,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    info: loggerInfo,
    debug: loggerDebug,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: loggerInfo,
      debug: loggerDebug,
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  isTruthyEnvValue: (value?: string) => {
    if (typeof value !== "string") {
      return false;
    }
    switch (value.trim().toLowerCase()) {
      case "":
      case "0":
      case "false":
      case "no":
      case "off":
        return false;
      default:
        return true;
    }
  },
  isWSL2Sync: () => false,
}));

let resolveTelegramFetch: typeof import("./fetch.js").resolveTelegramFetch;
let resolveTelegramApiBase: typeof import("./fetch.js").resolveTelegramApiBase;
let resolveTelegramTransport: typeof import("./fetch.js").resolveTelegramTransport;

type TelegramDispatcherPolicy = NonNullable<
  ReturnType<typeof resolveTelegramTransport>["dispatcherAttempts"]
>[number]["dispatcherPolicy"];

beforeAll(async () => {
  ({ resolveTelegramApiBase, resolveTelegramFetch, resolveTelegramTransport } =
    await import("./fetch.js"));
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const key of [
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "OPENCLAW_DEBUG_PROXY_URL",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "OPENCLAW_PROXY_URL",
  ]) {
    vi.stubEnv(key, "");
  }
  loggerInfo.mockReset();
  loggerDebug.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function resolveTelegramFetchOrThrow(
  proxyFetch?: typeof fetch,
  options?: { network?: { autoSelectFamily?: boolean; dnsResultOrder?: "ipv4first" | "verbatim" } },
) {
  return resolveTelegramFetch(proxyFetch, options);
}

function getDispatcherFromUndiciCall(nth: number) {
  const call = undiciFetch.mock.calls[nth - 1] as [RequestInfo | URL, RequestInit?] | undefined;
  if (!call) {
    throw new Error(`missing undici fetch call #${nth}`);
  }
  const init = call[1] as (RequestInit & { dispatcher?: unknown }) | undefined;
  return init?.dispatcher as
    | {
        options?: {
          allowH2?: boolean;
          connect?: Record<string, unknown>;
          proxyTls?: Record<string, unknown>;
          requestTls?: Record<string, unknown>;
        };
      }
    | undefined;
}

function buildFetchFallbackError(code: string) {
  const connectErr = Object.assign(new Error(`connect ${code} api.telegram.org:443`), {
    code,
  });
  return Object.assign(new TypeError("fetch failed"), {
    cause: connectErr,
  });
}

const STICKY_IPV4_FALLBACK_NETWORK = {
  network: {
    autoSelectFamily: true,
    dnsResultOrder: "ipv4first" as const,
  },
};

async function runDefaultStickyIpv4FallbackProbe(code = "EHOSTUNREACH"): Promise<void> {
  undiciFetch
    .mockRejectedValueOnce(buildFetchFallbackError(code))
    .mockResolvedValueOnce({ ok: true } as Response)
    .mockResolvedValueOnce({ ok: true } as Response);

  const resolved = resolveTelegramFetchOrThrow(undefined, STICKY_IPV4_FALLBACK_NETWORK);
  await resolved("https://api.telegram.org/botx/sendMessage");
  await resolved("https://api.telegram.org/botx/sendChatAction");
}

function primeStickyFallbackRetry(code = "EHOSTUNREACH", successCount = 2): void {
  undiciFetch.mockRejectedValueOnce(buildFetchFallbackError(code));
  for (let i = 0; i < successCount; i += 1) {
    undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
  }
}

function expectStickyAutoSelectDispatcher(
  dispatcher:
    | {
        options?: {
          allowH2?: boolean;
          connect?: Record<string, unknown>;
          proxyTls?: Record<string, unknown>;
          requestTls?: Record<string, unknown>;
        };
      }
    | undefined,
  field: "connect" | "proxyTls" | "requestTls" = "connect",
): void {
  expect(dispatcher?.options?.[field]).toEqual(
    expect.objectContaining({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    }),
  );
}

function expectHttp1OnlyDispatcher(
  dispatcher:
    | {
        options?: {
          allowH2?: boolean;
        };
      }
    | undefined,
): void {
  expect(dispatcher?.options).toEqual(
    expect.objectContaining({
      allowH2: false,
    }),
  );
}

function expectPinnedIpv4ConnectDispatcher(args: {
  pinnedCall: number;
  firstCall?: number;
  followupCall?: number;
}): void {
  const pinnedDispatcher = getDispatcherFromUndiciCall(args.pinnedCall);
  expect(pinnedDispatcher?.options?.connect).toEqual(
    expect.objectContaining({
      family: 4,
      autoSelectFamily: false,
    }),
  );
  if (args.firstCall) {
    expect(getDispatcherFromUndiciCall(args.firstCall)).not.toBe(pinnedDispatcher);
  }
  if (args.followupCall) {
    expect(getDispatcherFromUndiciCall(args.followupCall)).toBe(pinnedDispatcher);
  }
}

function expectPinnedFallbackIpDispatcher(callIndex: number) {
  const dispatcher = getDispatcherFromUndiciCall(callIndex);
  expect(dispatcher?.options?.connect).toEqual(
    expect.objectContaining({
      family: 4,
      autoSelectFamily: false,
      lookup: expect.any(Function),
    }),
  );
  const callback = vi.fn();
  (
    dispatcher?.options?.connect?.lookup as
      | ((hostname: string, callback: (err: null, address: string, family: number) => void) => void)
      | undefined
  )?.("api.telegram.org", callback);
  expect(callback).toHaveBeenCalledWith(null, "149.154.167.220", 4);
}

function expectCallerDispatcherPreserved(callIndexes: number[], dispatcher: unknown) {
  for (const callIndex of callIndexes) {
    const callInit = undiciFetch.mock.calls[callIndex - 1]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(callInit?.dispatcher).toBe(dispatcher);
  }
}

async function expectNoStickyRetryWithSameDispatcher(params: {
  resolved: ReturnType<typeof resolveTelegramFetchOrThrow>;
  expectedAgentCtor: typeof ProxyAgentCtor | typeof EnvHttpProxyAgentCtor;
  field: "connect" | "proxyTls" | "requestTls";
}) {
  await expect(params.resolved("https://api.telegram.org/botx/sendMessage")).rejects.toThrow(
    "fetch failed",
  );
  await params.resolved("https://api.telegram.org/botx/sendChatAction");

  expect(undiciFetch).toHaveBeenCalledTimes(2);
  expect(params.expectedAgentCtor).toHaveBeenCalledTimes(1);

  const firstDispatcher = getDispatcherFromUndiciCall(1);
  const secondDispatcher = getDispatcherFromUndiciCall(2);

  expect(firstDispatcher).toBe(secondDispatcher);
  expectStickyAutoSelectDispatcher(firstDispatcher, params.field);
  expect(firstDispatcher?.options?.[params.field]?.family).not.toBe(4);
}

afterEach(() => {
  undiciFetch.mockReset();
  setGlobalDispatcher.mockReset();
  AgentCtor.mockClear();
  EnvHttpProxyAgentCtor.mockClear();
  ProxyAgentCtor.mockClear();
  setDefaultResultOrder.mockReset();
  setDefaultAutoSelectFamily.mockReset();
  vi.clearAllMocks();
});

describe("resolveTelegramFetch", () => {
  it("normalizes a full bot endpoint apiRoot before callers append bot paths", () => {
    expect(resolveTelegramApiBase("https://api.telegram.org/bot123456:ABC/")).toBe(
      "https://api.telegram.org",
    );
  });

  it("wraps proxy fetches and leaves retry policy to caller-provided fetch", async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;

    const resolved = resolveTelegramFetchOrThrow(proxyFetch);

    await resolved("https://api.telegram.org/botx/getMe");

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("does not double-wrap an already wrapped proxy fetch", async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const wrapped = resolveFetch(proxyFetch);

    const resolved = resolveTelegramFetch(wrapped);

    expect(resolved).toBe(wrapped);
  });

  it("uses resolver-scoped Agent dispatcher with configured transport policy", async () => {
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "verbatim",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(AgentCtor).toHaveBeenCalledTimes(1);
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();

    const dispatcher = getDispatcherFromUndiciCall(1);
    expect(dispatcher).toBeDefined();
    expectHttp1OnlyDispatcher(dispatcher);
    expect(dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(typeof dispatcher?.options?.connect?.lookup).toBe("function");
  });

  it("emits default transport decisions at debug level", () => {
    resolveTelegramFetchOrThrow();

    expect(loggerInfo).not.toHaveBeenCalledWith("autoSelectFamily=true (default-node22)");
    expect(loggerInfo).not.toHaveBeenCalledWith("dnsResultOrder=ipv4first (default-node22)");
    expect(loggerDebug).toHaveBeenCalledWith("autoSelectFamily=true (default-node22)");
    expect(loggerDebug).toHaveBeenCalledWith("dnsResultOrder=ipv4first (default-node22)");
  });

  it("uses EnvHttpProxyAgent dispatcher when proxy env is configured", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        httpsProxy: "http://127.0.0.1:7890",
      }),
    );
    expect(AgentCtor).not.toHaveBeenCalled();

    const dispatcher = getDispatcherFromUndiciCall(1);
    expectHttp1OnlyDispatcher(dispatcher);
    expect(dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(dispatcher?.options?.proxyTls).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
  });

  it("uses the OpenClaw debug proxy URL when no explicit proxy fetch is provided", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "http://127.0.0.1:7777");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetch(undefined);
    await resolved("https://api.telegram.org/botTOKEN/getMe");

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(ProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        allowH2: false,
        uri: "http://127.0.0.1:7777",
      }),
    );
  });

  it("uses OPENCLAW_PROXY_URL as a Telegram explicit proxy when proxy env is absent", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://127.0.0.1:7788");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const transport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await transport.fetch("https://api.telegram.org/botTOKEN/getMe");

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(ProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        allowH2: false,
        uri: "http://127.0.0.1:7788",
        requestTls: expect.objectContaining({
          autoSelectFamily: false,
        }),
      }),
    );
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    expect(transport.dispatcherAttempts?.[0]?.dispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "explicit-proxy",
        proxyUrl: "http://127.0.0.1:7788",
      }),
    );
  });

  it("preserves caller-provided custom fetch when OPENCLAW_PROXY_URL is present", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://127.0.0.1:7788");
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;

    const transport = resolveTelegramTransport(proxyFetch, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await transport.fetch("https://api.telegram.org/botTOKEN/getMe");

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(ProxyAgentCtor).not.toHaveBeenCalled();
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    expect(transport.sourceFetch).not.toBe(undiciFetch);
    expect(transport.dispatcherAttempts).toBeUndefined();
  });

  it("prefers standard proxy env over OPENCLAW_PROXY_URL for Telegram", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://127.0.0.1:7788");
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(ProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
  });

  it("pins env-proxy transport policy onto proxyTls for proxied HTTPS requests", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    const dispatcher = getDispatcherFromUndiciCall(1);
    expectHttp1OnlyDispatcher(dispatcher);
    expect(dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(dispatcher?.options?.proxyTls).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
  });

  it("keeps resolver-scoped transport policy for OpenClaw proxy fetches", async () => {
    const { makeProxyFetch } = await import("./proxy.js");
    const proxyFetch = makeProxyFetch("http://127.0.0.1:7890");
    ProxyAgentCtor.mockClear();
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(proxyFetch, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    const dispatcher = getDispatcherFromUndiciCall(1);
    expectHttp1OnlyDispatcher(dispatcher);
    expect(dispatcher?.options).toEqual(
      expect.objectContaining({
        uri: "http://127.0.0.1:7890",
      }),
    );
    expect(dispatcher?.options?.requestTls).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
      }),
    );
  });

  it("exports fallback dispatcher attempts for Telegram media downloads", () => {
    const transport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    expect(transport.sourceFetch).toBeDefined();
    expect(transport.fetch).not.toBe(transport.sourceFetch);
    expect(transport.dispatcherAttempts).toHaveLength(3);

    const [defaultAttempt, ipv4Attempt, pinnedAttempt] = transport.dispatcherAttempts as Array<{
      dispatcherPolicy?: TelegramDispatcherPolicy;
    }>;

    expect(defaultAttempt.dispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "direct",
        connect: expect.objectContaining({
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 300,
          lookup: expect.any(Function),
        }),
      }),
    );
    expect(ipv4Attempt.dispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "direct",
        connect: expect.objectContaining({
          family: 4,
          autoSelectFamily: false,
          lookup: expect.any(Function),
        }),
      }),
    );
    expect(pinnedAttempt.dispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "direct",
        pinnedHostname: {
          hostname: "api.telegram.org",
          addresses: ["149.154.167.220"],
        },
        connect: expect.objectContaining({
          family: 4,
          autoSelectFamily: false,
          lookup: expect.any(Function),
        }),
      }),
    );
  });

  it("does not blind-retry when sticky IPv4 fallback is disallowed for explicit proxy paths", async () => {
    const { makeProxyFetch } = await import("./proxy.js");
    const proxyFetch = makeProxyFetch("http://127.0.0.1:7890");
    ProxyAgentCtor.mockClear();
    primeStickyFallbackRetry("EHOSTUNREACH", 1);

    const resolved = resolveTelegramFetchOrThrow(proxyFetch, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expectNoStickyRetryWithSameDispatcher({
      resolved,
      expectedAgentCtor: ProxyAgentCtor,
      field: "requestTls",
    });
  });

  it("does not blind-retry when sticky IPv4 fallback is disallowed for env proxy paths", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    primeStickyFallbackRetry("EHOSTUNREACH", 1);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expectNoStickyRetryWithSameDispatcher({
      resolved,
      expectedAgentCtor: EnvHttpProxyAgentCtor,
      field: "connect",
    });
  });

  it("uses ALL_PROXY env as EnvHttpProxyAgent transport", async () => {
    vi.stubEnv("ALL_PROXY", "http://127.0.0.1:7891");
    vi.stubEnv("all_proxy", "http://127.0.0.1:7891");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const transport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });
    const resolved = transport.fetch;

    await resolved("https://api.telegram.org/botx/sendMessage");

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        allowH2: false,
        httpProxy: "http://127.0.0.1:7891",
        httpsProxy: "http://127.0.0.1:7891",
      }),
    );
    expect(AgentCtor).not.toHaveBeenCalled();

    expect(transport.dispatcherAttempts?.[0]?.dispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "env-proxy",
      }),
    );
  });

  it("arms sticky IPv4 fallback when env proxy init falls back to direct Agent", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    EnvHttpProxyAgentCtor.mockImplementationOnce(function ThrowingEnvProxyAgent() {
      throw new Error("invalid proxy config");
    });
    await runDefaultStickyIpv4FallbackProbe();

    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(AgentCtor).toHaveBeenCalledTimes(2);

    expectPinnedIpv4ConnectDispatcher({
      firstCall: 1,
      pinnedCall: 2,
      followupCall: 3,
    });
  });

  it("arms sticky IPv4 fallback when NO_PROXY bypasses telegram under env proxy", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    vi.stubEnv("no_proxy", "api.telegram.org");
    await runDefaultStickyIpv4FallbackProbe();

    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(2);
    expect(AgentCtor).not.toHaveBeenCalled();

    expectPinnedIpv4ConnectDispatcher({
      firstCall: 1,
      pinnedCall: 2,
      followupCall: 3,
    });
  });

  it("uses no_proxy over NO_PROXY when deciding env-proxy bypass", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "api.telegram.org");
    await runDefaultStickyIpv4FallbackProbe();

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(2);
    expectPinnedIpv4ConnectDispatcher({ pinnedCall: 2 });
  });

  it("matches whitespace and wildcard no_proxy entries like EnvHttpProxyAgent", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    vi.stubEnv("no_proxy", "localhost *.telegram.org");
    await runDefaultStickyIpv4FallbackProbe();

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(2);
    expectPinnedIpv4ConnectDispatcher({ pinnedCall: 2 });
  });

  it("fails closed when explicit proxy dispatcher initialization fails", async () => {
    const { makeProxyFetch } = await import("./proxy.js");
    const proxyFetch = makeProxyFetch("http://127.0.0.1:7890");
    ProxyAgentCtor.mockClear();
    ProxyAgentCtor.mockImplementationOnce(function ThrowingProxyAgent() {
      throw new Error("invalid proxy config");
    });

    expect(() =>
      resolveTelegramFetchOrThrow(proxyFetch, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      }),
    ).toThrow("explicit proxy dispatcher init failed: invalid proxy config");
  });

  it("falls back to Agent when env proxy dispatcher initialization fails", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    EnvHttpProxyAgentCtor.mockImplementationOnce(function ThrowingEnvProxyAgent() {
      throw new Error("invalid proxy config");
    });
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: false,
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(AgentCtor).toHaveBeenCalledTimes(1);

    const dispatcher = getDispatcherFromUndiciCall(1);
    expect(dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
      }),
    );
  });

  it("retries once and then keeps sticky IPv4 dispatcher for subsequent requests", async () => {
    primeStickyFallbackRetry("ETIMEDOUT");

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    await resolved("https://api.telegram.org/botx/sendMessage");
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(undiciFetch).toHaveBeenCalledTimes(3);

    const firstDispatcher = getDispatcherFromUndiciCall(1);
    const secondDispatcher = getDispatcherFromUndiciCall(2);
    const thirdDispatcher = getDispatcherFromUndiciCall(3);

    expect(firstDispatcher).toBeDefined();
    expect(secondDispatcher).toBeDefined();
    expect(thirdDispatcher).toBeDefined();

    expect(firstDispatcher).not.toBe(secondDispatcher);
    expect(secondDispatcher).toBe(thirdDispatcher);

    expectStickyAutoSelectDispatcher(firstDispatcher);
    expect(secondDispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        family: 4,
        autoSelectFamily: false,
      }),
    );
  });

  it("escalates from IPv4 fallback to pinned Telegram IP and keeps it sticky", async () => {
    undiciFetch
      .mockRejectedValueOnce(buildFetchFallbackError("ETIMEDOUT"))
      .mockRejectedValueOnce(buildFetchFallbackError("EHOSTUNREACH"))
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/sendMessage");
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(undiciFetch).toHaveBeenCalledTimes(4);

    const secondDispatcher = getDispatcherFromUndiciCall(2);
    const thirdDispatcher = getDispatcherFromUndiciCall(3);
    const fourthDispatcher = getDispatcherFromUndiciCall(4);

    expect(secondDispatcher).not.toBe(thirdDispatcher);
    expect(thirdDispatcher).toBe(fourthDispatcher);
    expectPinnedFallbackIpDispatcher(3);
  });

  it("keeps the armed fallback sticky when all attempts fail", async () => {
    undiciFetch
      .mockRejectedValueOnce(buildFetchFallbackError("ETIMEDOUT"))
      .mockRejectedValueOnce(buildFetchFallbackError("EHOSTUNREACH"))
      .mockRejectedValueOnce(buildFetchFallbackError("ETIMEDOUT"))
      .mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expect(resolved("https://api.telegram.org/botx/deleteWebhook")).rejects.toThrow(
      "fetch failed",
    );
    await resolved("https://api.telegram.org/botx/getMe");

    expect(undiciFetch).toHaveBeenCalledTimes(4);
    expectPinnedFallbackIpDispatcher(3);
    expect(getDispatcherFromUndiciCall(4)).toBe(getDispatcherFromUndiciCall(3));
  });

  it("preserves caller-provided dispatcher across fallback retry", async () => {
    const fetchError = buildFetchFallbackError("EHOSTUNREACH");
    undiciFetch.mockRejectedValueOnce(fetchError).mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    const callerDispatcher = { name: "caller" };

    await resolved("https://api.telegram.org/botx/sendMessage", {
      dispatcher: callerDispatcher,
    } as RequestInit);

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expectCallerDispatcherPreserved([1, 2], callerDispatcher);
  });

  it("does not arm sticky fallback from caller-provided dispatcher failures", async () => {
    primeStickyFallbackRetry();

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    const callerDispatcher = { name: "caller" };

    await resolved("https://api.telegram.org/botx/sendMessage", {
      dispatcher: callerDispatcher,
    } as RequestInit);
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expectCallerDispatcherPreserved([1, 2], callerDispatcher);
    const thirdDispatcher = getDispatcherFromUndiciCall(3);

    expectStickyAutoSelectDispatcher(thirdDispatcher);
    expect(thirdDispatcher?.options?.connect?.family).not.toBe(4);
  });

  it("does not retry when error codes do not match fallback rules", async () => {
    const fetchError = buildFetchFallbackError("ECONNRESET");
    undiciFetch.mockRejectedValue(fetchError);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    await expect(resolved("https://api.telegram.org/botx/sendMessage")).rejects.toThrow(
      "fetch failed",
    );

    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps per-resolver transport policy isolated across multiple accounts", async () => {
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolverA = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });
    const resolverB = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "verbatim",
      },
    });

    await resolverA("https://api.telegram.org/botA/getMe");
    await resolverB("https://api.telegram.org/botB/getMe");

    const dispatcherA = getDispatcherFromUndiciCall(1);
    const dispatcherB = getDispatcherFromUndiciCall(2);

    expect(dispatcherA).toBeDefined();
    expect(dispatcherB).toBeDefined();
    expect(dispatcherA).not.toBe(dispatcherB);

    expect(dispatcherA?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
      }),
    );
    expect(dispatcherB?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
      }),
    );

    // Core guarantee: Telegram transport no longer mutates process-global defaults.
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(setDefaultResultOrder).not.toHaveBeenCalled();
    expect(setDefaultAutoSelectFamily).not.toHaveBeenCalled();
  });

  describe("transport lifecycle", () => {
    it("passes a bounded keep-alive pool configuration to every constructed dispatcher", () => {
      resolveTelegramTransport(undefined, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      });

      // One direct Agent for the default dispatcher plus two lazy fallbacks not yet touched.
      expect(AgentCtor).toHaveBeenCalledTimes(1);
      const defaultAgent = AgentCtor.mock.instances[0]?.options;
      expect(defaultAgent).toEqual(
        expect.objectContaining({
          allowH2: false,
          keepAliveTimeout: expect.any(Number),
          keepAliveMaxTimeout: expect.any(Number),
          connections: expect.any(Number),
          pipelining: expect.any(Number),
        }),
      );
      const connections = (defaultAgent as { connections?: number }).connections;
      expect(connections).toBeGreaterThan(0);
      expect(connections).toBeLessThan(100);
    });

    it("close() destroys the default dispatcher and all lazily-created fallback dispatchers", async () => {
      undiciFetch
        .mockRejectedValueOnce(buildFetchFallbackError("EHOSTUNREACH"))
        .mockRejectedValueOnce(buildFetchFallbackError("EHOSTUNREACH"))
        .mockResolvedValueOnce({ ok: true } as Response);

      const transport = resolveTelegramTransport(undefined, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      });

      // Trigger fallback chain so the two lazy fallback dispatchers are instantiated.
      await transport.fetch("https://api.telegram.org/botx/getMe");

      // Three Agents total: default + IPv4 fallback + pinned-IP fallback.
      expect(AgentCtor).toHaveBeenCalledTimes(3);
      const instances = AgentCtor.mock.instances;
      expect(instances).toHaveLength(3);

      await transport.close();

      for (const instance of instances) {
        expect(instance.destroy).toHaveBeenCalledTimes(1);
      }
    });

    it("close() is idempotent", async () => {
      const transport = resolveTelegramTransport(undefined, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      });
      const instance = AgentCtor.mock.instances[0];

      await transport.close();
      await transport.close();
      await transport.close();

      expect(instance.destroy).toHaveBeenCalledTimes(1);
    });

    it("close() swallows dispatcher destroy failures so callers can safely fire-and-forget", async () => {
      const transport = resolveTelegramTransport(undefined, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      });
      const instance = AgentCtor.mock.instances[0];
      instance.destroy.mockRejectedValueOnce(new Error("already destroyed"));

      await expect(transport.close()).resolves.toBeUndefined();
    });
  });
});
