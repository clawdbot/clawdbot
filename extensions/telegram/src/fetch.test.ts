import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setDefaultResultOrder = vi.hoisted(() => vi.fn());
const getDefaultResultOrder = vi.hoisted(() => vi.fn(() => "ipv4first"));
const setDefaultAutoSelectFamily = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerDebug = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());

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
    getDefaultResultOrder,
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
    warn: loggerWarn,
    error: vi.fn(),
    child: () => ({
      info: loggerInfo,
      debug: loggerDebug,
      warn: loggerWarn,
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
type DirectTelegramDispatcherPolicy = Extract<TelegramDispatcherPolicy, { mode: "direct" }>;
type ExplicitProxyTelegramDispatcherPolicy = Extract<
  TelegramDispatcherPolicy,
  { mode: "explicit-proxy" }
>;

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
  loggerWarn.mockReset();
  getDefaultResultOrder.mockReset();
  getDefaultResultOrder.mockReturnValue("ipv4first");
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
  const dispatcher = init?.dispatcher as
    | {
        options?: {
          allowH2?: boolean;
          connect?: Record<string, unknown>;
          proxyTls?: Record<string, unknown>;
          requestTls?: Record<string, unknown>;
        };
      }
    | undefined;
  if (!dispatcher) {
    throw new Error(`missing dispatcher for undici fetch call #${nth}`);
  }
  return dispatcher;
}

function constructorOptions(ctor: ReturnType<typeof vi.fn>, label: string): unknown {
  const call = ctor.mock.calls.at(0);
  if (!call) {
    throw new Error(`missing ${label} constructor call`);
  }
  return call[0];
}

function buildFetchFallbackError(code: string) {
  const connectErr = Object.assign(new Error(`connect ${code} api.telegram.org:443`), {
    code,
  });
  return Object.assign(new TypeError("fetch failed"), {
    cause: connectErr,
  });
}

function buildCodeLessFetchFallbackError() {
  return new TypeError("fetch failed");
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
  const options = dispatcher?.options?.[field];
  expect(options?.autoSelectFamily).toBe(true);
  expect(options?.autoSelectFamilyAttemptTimeout).toBe(300);
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
  expect(dispatcher?.options?.allowH2).toBe(false);
}

function expectPinnedIpv4ConnectDispatcher(args: {
  pinnedCall: number;
  firstCall?: number;
  followupCall?: number;
}): void {
  const pinnedDispatcher = getDispatcherFromUndiciCall(args.pinnedCall);
  expect(pinnedDispatcher?.options?.connect?.family).toBe(4);
  expect(pinnedDispatcher?.options?.connect?.autoSelectFamily).toBe(false);
  if (args.firstCall) {
    expect(getDispatcherFromUndiciCall(args.firstCall)).not.toBe(pinnedDispatcher);
  }
  if (args.followupCall) {
    expect(getDispatcherFromUndiciCall(args.followupCall)).toBe(pinnedDispatcher);
  }
}

function expectPinnedFallbackIpDispatcher(callIndex: number) {
  const dispatcher = getDispatcherFromUndiciCall(callIndex);
  expect(dispatcher?.options?.connect?.family).toBe(4);
  expect(dispatcher?.options?.connect?.autoSelectFamily).toBe(false);
  expect(typeof dispatcher?.options?.connect?.lookup).toBe("function");
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

function loggerHasMessageContaining(logger: ReturnType<typeof vi.fn>, fragment: string): boolean {
  return logger.mock.calls.some(
    ([message]) => typeof message === "string" && message.includes(fragment),
  );
}

function expectLoggerMessageContaining(logger: ReturnType<typeof vi.fn>, fragment: string): void {
  expect(loggerHasMessageContaining(logger, fragment)).toBe(true);
}

function expectNoLoggerMessageContaining(logger: ReturnType<typeof vi.fn>, fragment: string): void {
  expect(loggerHasMessageContaining(logger, fragment)).toBe(false);
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

  it("does not double-wrap an already wrapped proxy fetch", () => {
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
    expectHttp1OnlyDispatcher(dispatcher);
    expect(dispatcher?.options?.connect?.autoSelectFamily).toBe(true);
    expect(dispatcher?.options?.connect?.autoSelectFamilyAttemptTimeout).toBe(300);
    expect(typeof dispatcher?.options?.connect?.lookup).toBe("function");
  });

  it("emits default transport decisions at debug level", () => {
    resolveTelegramFetchOrThrow();

    expect(loggerInfo).not.toHaveBeenCalledWith("autoSelectFamily=true (default-node22)");
    expect(loggerInfo).not.toHaveBeenCalledWith("dnsResultOrder=ipv4first (process-default)");
    expect(loggerDebug).toHaveBeenCalledWith("autoSelectFamily=true (default-node22)");
    expect(loggerDebug).toHaveBeenCalledWith("dnsResultOrder=ipv4first (process-default)");
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
    const envProxyOptions = constructorOptions(EnvHttpProxyAgentCtor, "env proxy") as {
      httpsProxy?: string;
    };
    expect(envProxyOptions.httpsProxy).toBe("http://127.0.0.1:7890");
    expect(AgentCtor).not.toHaveBeenCalled();

    const dispatcher = getDispatcherFromUndiciCall(1);
    expectHttp1OnlyDispatcher(dispatcher);
    expect(dispatcher?.options?.connect?.autoSelectFamily).toBe(false);
    expect(dispatcher?.options?.connect?.autoSelectFamilyAttemptTimeout).toBe(300);
    expect(dispatcher?.options?.proxyTls?.autoSelectFamily).toBe(false);
    expect(dispatcher?.options?.proxyTls?.autoSelectFamilyAttemptTimeout).toBe(300);
  });

  it("uses the OpenClaw debug proxy URL when no explicit proxy fetch is provided", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "http://127.0.0.1:7777");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetch(undefined);
    await resolved("https://api.telegram.org/botTOKEN/getMe");

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);
    const proxyOptions = constructorOptions(ProxyAgentCtor, "debug proxy") as {
      allowH2?: boolean;
      uri?: string;
    };
    expect(proxyOptions.allowH2).toBe(false);
    expect(proxyOptions.uri).toBe("http://127.0.0.1:7777");
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
    const proxyOptions = constructorOptions(ProxyAgentCtor, "OpenClaw proxy") as {
      allowH2?: boolean;
      uri?: string;
      requestTls?: { autoSelectFamily?: boolean };
    };
    expect(proxyOptions.allowH2).toBe(false);
    expect(proxyOptions.uri).toBe("http://127.0.0.1:7788");
    expect(proxyOptions.requestTls?.autoSelectFamily).toBe(false);
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    const dispatcherPolicy = transport.dispatcherAttempts?.[0]?.dispatcherPolicy as
      | ExplicitProxyTelegramDispatcherPolicy
      | undefined;
    expect(dispatcherPolicy?.mode).toBe("explicit-proxy");
    expect(dispatcherPolicy?.proxyUrl).toBe("http://127.0.0.1:7788");
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
    expect(dispatcher?.options?.connect?.autoSelectFamily).toBe(true);
    expect(dispatcher?.options?.connect?.autoSelectFamilyAttemptTimeout).toBe(300);
    expect(dispatcher?.options?.proxyTls?.autoSelectFamily).toBe(true);
    expect(dispatcher?.options?.proxyTls?.autoSelectFamilyAttemptTimeout).toBe(300);
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
    expect((dispatcher?.options as { uri?: string } | undefined)?.uri).toBe(
      "http://127.0.0.1:7890",
    );
    expect(dispatcher?.options?.requestTls?.autoSelectFamily).toBe(false);
  });

  it("exports fallback dispatcher attempts for Telegram media downloads", async () => {
    undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
    const transport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expect(
      transport.sourceFetch("https://api.telegram.org/botTOKEN/getFile"),
    ).resolves.toEqual({ ok: true });
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botTOKEN/getFile",
      undefined,
    );
    expect(transport.fetch).not.toBe(transport.sourceFetch);
    expect(transport.dispatcherAttempts).toHaveLength(3);

    const [defaultAttempt, ipv4Attempt, pinnedAttempt] = transport.dispatcherAttempts as Array<{
      dispatcherPolicy?: DirectTelegramDispatcherPolicy;
    }>;

    const defaultPolicy = defaultAttempt.dispatcherPolicy;
    const ipv4Policy = ipv4Attempt.dispatcherPolicy;
    const pinnedPolicy = pinnedAttempt.dispatcherPolicy;
    expect(defaultPolicy?.mode).toBe("direct");
    expect(defaultPolicy?.connect?.autoSelectFamily).toBe(true);
    expect(defaultPolicy?.connect?.autoSelectFamilyAttemptTimeout).toBe(300);
    expect(typeof defaultPolicy?.connect?.lookup).toBe("function");
    expect(ipv4Policy?.mode).toBe("direct");
    expect(ipv4Policy?.connect?.family).toBe(4);
    expect(ipv4Policy?.connect?.autoSelectFamily).toBe(false);
    expect(typeof ipv4Policy?.connect?.lookup).toBe("function");
    expect(pinnedPolicy?.mode).toBe("direct");
    expect(pinnedPolicy?.pinnedHostname).toEqual({
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
    });
    expect(pinnedPolicy?.connect?.family).toBe(4);
    expect(pinnedPolicy?.connect?.autoSelectFamily).toBe(false);
    expect(typeof pinnedPolicy?.connect?.lookup).toBe("function");
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
    const proxyOptions = constructorOptions(EnvHttpProxyAgentCtor, "env proxy") as {
      allowH2?: boolean;
      httpProxy?: string;
      httpsProxy?: string;
    };
    expect(proxyOptions.allowH2).toBe(false);
    expect(proxyOptions.httpProxy).toBe("http://127.0.0.1:7891");
    expect(proxyOptions.httpsProxy).toBe("http://127.0.0.1:7891");
    expect(AgentCtor).not.toHaveBeenCalled();

    expect(transport.dispatcherAttempts?.[0]?.dispatcherPolicy?.mode).toBe("env-proxy");
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
    expect(dispatcher?.options?.connect?.autoSelectFamily).toBe(false);
  });

  it("retries once, keeps sticky IPv4, then recovers to primary dispatcher", async () => {
    undiciFetch.mockRejectedValueOnce(buildFetchFallbackError("ETIMEDOUT"));
    for (let i = 0; i < 7; i += 1) {
      undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
    }

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    await resolved("https://api.telegram.org/botx/sendMessage");
    for (let i = 0; i < 4; i += 1) {
      await resolved(`https://api.telegram.org/botx/sendChatAction?sticky=${i}`);
    }
    await resolved("https://api.telegram.org/botx/getMe");
    await resolved("https://api.telegram.org/botx/deleteWebhook");

    expect(undiciFetch).toHaveBeenCalledTimes(8);

    const firstDispatcher = getDispatcherFromUndiciCall(1);
    const secondDispatcher = getDispatcherFromUndiciCall(2);
    const sixthDispatcher = getDispatcherFromUndiciCall(6);
    const seventhDispatcher = getDispatcherFromUndiciCall(7);
    const eighthDispatcher = getDispatcherFromUndiciCall(8);

    expect(firstDispatcher).not.toBe(secondDispatcher);
    expect(secondDispatcher).toBe(sixthDispatcher);
    expect(seventhDispatcher).toBe(firstDispatcher);
    expect(eighthDispatcher).toBe(firstDispatcher);

    expectStickyAutoSelectDispatcher(firstDispatcher);
    expect(secondDispatcher?.options?.connect?.family).toBe(4);
    expect(secondDispatcher?.options?.connect?.autoSelectFamily).toBe(false);
    expectLoggerMessageContaining(
      loggerDebug,
      "fetch fallback: enabling sticky IPv4-only dispatcher",
    );
    expectLoggerMessageContaining(
      loggerDebug,
      "fetch fallback: recovered from attempt 1 to attempt 0",
    );
    expectNoLoggerMessageContaining(
      loggerWarn,
      "fetch fallback: enabling sticky IPv4-only dispatcher",
    );
  });

  it("escalates from IPv4 fallback to pinned Telegram IP and recovers to primary", async () => {
    undiciFetch
      .mockRejectedValueOnce(buildFetchFallbackError("ETIMEDOUT"))
      .mockRejectedValueOnce(buildFetchFallbackError("EHOSTUNREACH"));
    for (let i = 0; i < 7; i += 1) {
      undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
    }

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/sendMessage");
    for (let i = 0; i < 4; i += 1) {
      await resolved(`https://api.telegram.org/botx/sendChatAction?sticky=${i}`);
    }
    await resolved("https://api.telegram.org/botx/getMe");
    await resolved("https://api.telegram.org/botx/deleteWebhook");

    expect(undiciFetch).toHaveBeenCalledTimes(9);

    const firstDispatcher = getDispatcherFromUndiciCall(1);
    const secondDispatcher = getDispatcherFromUndiciCall(2);
    const thirdDispatcher = getDispatcherFromUndiciCall(3);
    const seventhDispatcher = getDispatcherFromUndiciCall(7);
    const eighthDispatcher = getDispatcherFromUndiciCall(8);
    const ninthDispatcher = getDispatcherFromUndiciCall(9);

    expect(secondDispatcher).not.toBe(thirdDispatcher);
    expect(thirdDispatcher).toBe(seventhDispatcher);
    expect(eighthDispatcher).toBe(firstDispatcher);
    expect(ninthDispatcher).toBe(firstDispatcher);
    expectPinnedFallbackIpDispatcher(3);
    expectLoggerMessageContaining(loggerWarn, "fetch fallback: DNS-resolved IP unreachable");
    expectLoggerMessageContaining(
      loggerDebug,
      "fetch fallback: recovered from attempt 2 to attempt 0",
    );
  });

  it("keeps sticky fallback after a failed primary recovery probe", async () => {
    undiciFetch
      .mockRejectedValueOnce(buildFetchFallbackError("ETIMEDOUT"))
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockRejectedValueOnce(buildFetchFallbackError("ETIMEDOUT"))
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    await resolved("https://api.telegram.org/botx/sendMessage");
    for (let i = 0; i < 4; i += 1) {
      await resolved(`https://api.telegram.org/botx/sendChatAction?sticky=${i}`);
    }
    await resolved("https://api.telegram.org/botx/getMe");
    await resolved("https://api.telegram.org/botx/deleteWebhook");

    expect(undiciFetch).toHaveBeenCalledTimes(9);

    const firstDispatcher = getDispatcherFromUndiciCall(1);
    const secondDispatcher = getDispatcherFromUndiciCall(2);

    expect(firstDispatcher).not.toBe(secondDispatcher);
    expect(getDispatcherFromUndiciCall(6)).toBe(secondDispatcher);
    expect(getDispatcherFromUndiciCall(7)).toBe(firstDispatcher);
    expect(getDispatcherFromUndiciCall(8)).toBe(secondDispatcher);
    expect(getDispatcherFromUndiciCall(9)).toBe(secondDispatcher);
    expectLoggerMessageContaining(loggerDebug, "fetch fallback: re-probing primary dispatcher");
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

  it("falls back on code-less fetch failed envelopes", async () => {
    undiciFetch
      .mockRejectedValueOnce(buildCodeLessFetchFallbackError())
      .mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/deleteWebhook");

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(getDispatcherFromUndiciCall(1)).not.toBe(getDispatcherFromUndiciCall(2));
  });

  it("cools down a repeatedly failing sticky fallback and probes earlier attempts", async () => {
    for (let i = 0; i < 7; i += 1) {
      undiciFetch.mockRejectedValueOnce(buildFetchFallbackError("ENETUNREACH"));
    }
    undiciFetch
      .mockRejectedValueOnce(buildFetchFallbackError("ENETUNREACH"))
      .mockRejectedValueOnce(buildFetchFallbackError("ENETUNREACH"));

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expect(resolved("https://api.telegram.org/botx/deleteWebhook")).rejects.toThrow(
      "fetch failed",
    );
    for (let i = 0; i < 4; i += 1) {
      await expect(resolved("https://api.telegram.org/botx/getUpdates")).rejects.toThrow(
        "fetch failed",
      );
    }
    await expect(resolved("https://api.telegram.org/botx/getUpdates")).rejects.toThrow(
      "temporarily unhealthy",
    );

    expect(undiciFetch).toHaveBeenCalledTimes(9);
    expect(getDispatcherFromUndiciCall(7)).toBe(getDispatcherFromUndiciCall(3));
    expect(getDispatcherFromUndiciCall(8)).toBe(getDispatcherFromUndiciCall(1));
    expect(getDispatcherFromUndiciCall(9)).toBe(getDispatcherFromUndiciCall(2));
    expectLoggerMessageContaining(
      loggerWarn,
      "telegram transport attempt marked temporarily unhealthy",
    );
    expectLoggerMessageContaining(loggerDebug, "fetch fallback: re-probing primary dispatcher");
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

    expect(dispatcherA).not.toBe(dispatcherB);

    expect(dispatcherA?.options?.connect?.autoSelectFamily).toBe(false);
    expect(dispatcherB?.options?.connect?.autoSelectFamily).toBe(true);

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
      expect(typeof defaultAgent).toBe("object");
      expect((defaultAgent as { allowH2?: boolean } | undefined)?.allowH2).toBe(false);
      expect(typeof (defaultAgent as { keepAliveTimeout?: unknown }).keepAliveTimeout).toBe(
        "number",
      );
      expect(typeof (defaultAgent as { keepAliveMaxTimeout?: unknown }).keepAliveMaxTimeout).toBe(
        "number",
      );
      expect(typeof (defaultAgent as { connections?: unknown }).connections).toBe("number");
      expect(typeof (defaultAgent as { pipelining?: unknown }).pipelining).toBe("number");
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
