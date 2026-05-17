import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { undiciFetchMock, agentSpy, envHttpProxyAgentSpy, proxyAgentSpy } = vi.hoisted(() => ({
  undiciFetchMock: vi.fn(),
  agentSpy: vi.fn(),
  envHttpProxyAgentSpy: vi.fn(),
  proxyAgentSpy: vi.fn(),
}));

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

vi.mock("undici", () => {
  class Agent {
    options: unknown;
    constructor(options?: unknown) {
      this.options = options;
      agentSpy(options);
    }
  }
  class EnvHttpProxyAgent {
    options: unknown;
    constructor(options?: unknown) {
      if (
        typeof options === "object" &&
        options !== null &&
        ("httpsProxy" in options || "httpProxy" in options)
      ) {
        const proxyOptions = options as { httpsProxy?: unknown; httpProxy?: unknown };
        if (proxyOptions.httpsProxy === "bad-proxy" || proxyOptions.httpProxy === "bad-proxy") {
          throw new Error("bad env proxy");
        }
      }
      this.options = options;
      envHttpProxyAgentSpy(options);
    }
  }
  class ProxyAgent {
    options: unknown;
    uri: string;
    constructor(options: string | { uri: string; allowH2?: boolean }) {
      const resolved = typeof options === "string" ? { uri: options } : options;
      if (resolved.uri === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.options = resolved;
      this.uri = resolved.uri;
      proxyAgentSpy(resolved);
    }
  }
  return {
    Agent,
    EnvHttpProxyAgent,
    ProxyAgent,
    fetch: undiciFetchMock,
  };
});

let resolveDiscordRestFetch: typeof import("./rest-fetch.js").resolveDiscordRestFetch;

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function argAt(mock: MockWithCalls, callIndex: number, argIndex: number): unknown {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`expected call ${callIndex}`);
  }
  return call[argIndex];
}

function objectArgAt(
  mock: MockWithCalls,
  callIndex: number,
  argIndex: number,
): Record<string, unknown> {
  const value = argAt(mock, callIndex, argIndex);
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function installUndiciRuntimeDeps(): void {
  class Agent {
    options: unknown;
    constructor(options?: unknown) {
      this.options = options;
      agentSpy(options);
    }
  }
  class EnvHttpProxyAgent {
    options: unknown;
    constructor(options?: unknown) {
      if (
        typeof options === "object" &&
        options !== null &&
        ("httpsProxy" in options || "httpProxy" in options)
      ) {
        const proxyOptions = options as { httpsProxy?: unknown; httpProxy?: unknown };
        if (proxyOptions.httpsProxy === "bad-proxy" || proxyOptions.httpProxy === "bad-proxy") {
          throw new Error("bad env proxy");
        }
      }
      this.options = options;
      envHttpProxyAgentSpy(options);
    }
  }
  class ProxyAgent {
    options: unknown;
    uri: string;
    constructor(options: string | { uri: string; allowH2?: boolean }) {
      const resolved = typeof options === "string" ? { uri: options } : options;
      if (resolved.uri === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.options = resolved;
      this.uri = resolved.uri;
      proxyAgentSpy(resolved);
    }
  }
  class Pool {
    constructor(
      readonly origin: unknown,
      readonly options: unknown,
    ) {}
  }
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent,
    EnvHttpProxyAgent,
    Pool,
    ProxyAgent,
    fetch: undiciFetchMock,
  };
}

describe("resolveDiscordRestFetch", () => {
  const proxyEnvKeys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NO_PROXY",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ] as const;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    ({ resolveDiscordRestFetch } = await import("./rest-fetch.js"));
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const key of proxyEnvKeys) {
      vi.stubEnv(key, "");
    }
    undiciFetchMock.mockReset();
    agentSpy.mockReset();
    envHttpProxyAgentSpy.mockReset();
    proxyAgentSpy.mockReset();
    installUndiciRuntimeDeps();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeTempCa(contents: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-discord-rest-proxy-ca-"));
    tempDirs.push(dir);
    const caFile = path.join(dir, "proxy-ca.pem");
    writeFileSync(caFile, contents, "utf8");
    return caFile;
  }

  it("uses undici proxy fetch when a proxy URL is configured", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockClear().mockResolvedValue(new Response("ok", { status: 200 }));
    proxyAgentSpy.mockClear();
    const fetcher = resolveDiscordRestFetch("http://127.0.0.1:8080", runtime);

    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    const proxyOptions = objectArgAt(proxyAgentSpy, 0, 0);
    expect(proxyOptions.uri).toBe("http://127.0.0.1:8080");
    expect(proxyOptions.allowH2).toBe(false);
    expect(argAt(undiciFetchMock, 0, 0)).toBe(
      "https://discord.com/api/v10/oauth2/applications/@me",
    );
    const fetchOptions = objectArgAt(undiciFetchMock, 0, 1);
    const dispatcher = recordField(fetchOptions.dispatcher, "dispatcher");
    expect(dispatcher.uri).toBe("http://127.0.0.1:8080");
    expect(recordField(dispatcher.options, "dispatcher.options").allowH2).toBe(false);
    expect(runtime.log).toHaveBeenCalledWith("discord: rest proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("uses managed proxy CA trust when a configured REST proxy matches the managed proxy", async () => {
    const caFile = writeTempCa("discord-rest-configured-proxy-ca");
    vi.stubEnv("HTTPS_PROXY", "https://127.0.0.1:8443");
    vi.stubEnv("https_proxy", "https://127.0.0.1:8443");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const fetcher = resolveDiscordRestFetch("https://127.0.0.1:8443", runtime);
    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    const proxyOptions = objectArgAt(proxyAgentSpy, 0, 0);
    expect(proxyOptions.uri).toBe("https://127.0.0.1:8443");
    expect(recordField(proxyOptions.proxyTls, "proxyTls").ca).toBe(
      "discord-rest-configured-proxy-ca",
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: rest proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to global fetch when proxy URL is invalid", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    const fetcher = resolveDiscordRestFetch("bad-proxy", runtime);

    expect(fetcher).toBe(fetch);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("falls back to global fetch when proxy URL is remote", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;

    const fetcher = resolveDiscordRestFetch("http://proxy.test:8080", runtime);

    expect(fetcher).toBe(fetch);
    expect(proxyAgentSpy).not.toHaveBeenCalled();
    expect(String(argAt(runtime.error, 0, 0))).toContain("loopback host");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("uses undici proxy fetch when the proxy URL is IPv6 loopback", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const fetcher = resolveDiscordRestFetch("http://[::1]:8080", runtime);

    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    const proxyOptions = objectArgAt(proxyAgentSpy, 0, 0);
    expect(proxyOptions.uri).toBe("http://[::1]:8080");
    expect(proxyOptions.allowH2).toBe(false);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("uses undici Agent with IPv4-first lookup when no discord proxy URL is configured", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const fetcher = resolveDiscordRestFetch(undefined, runtime);
    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    const agentOptions = objectArgAt(agentSpy, 0, 0);
    expect(agentOptions.allowH2).toBe(false);
    expect(typeof recordField(agentOptions.connect, "connect").lookup).toBe("function");
    expect(argAt(undiciFetchMock, 0, 0)).toBe(
      "https://discord.com/api/v10/oauth2/applications/@me",
    );
    const fetchOptions = objectArgAt(undiciFetchMock, 0, 1);
    const dispatcherOptions = recordField(
      recordField(fetchOptions.dispatcher, "dispatcher").options,
      "dispatcher.options",
    );
    expect(dispatcherOptions.allowH2).toBe(false);
    expect(typeof recordField(dispatcherOptions.connect, "dispatcher.options.connect").lookup).toBe(
      "function",
    );
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("uses managed env proxy CA trust when no discord proxy URL is configured", async () => {
    const caFile = writeTempCa("discord-rest-managed-proxy-ca");
    vi.stubEnv("HTTPS_PROXY", "https://proxy.example:8443");
    vi.stubEnv("https_proxy", "https://proxy.example:8443");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const fetcher = resolveDiscordRestFetch(undefined, runtime);
    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    expect(agentSpy).not.toHaveBeenCalled();
    const proxyOptions = objectArgAt(envHttpProxyAgentSpy, 0, 0);
    expect(proxyOptions.httpsProxy).toBe("https://proxy.example:8443");
    expect(recordField(proxyOptions.proxyTls, "proxyTls").ca).toBe("discord-rest-managed-proxy-ca");
    const fetchOptions = objectArgAt(undiciFetchMock, 0, 1);
    const dispatcherOptions = recordField(
      recordField(fetchOptions.dispatcher, "dispatcher").options,
      "dispatcher.options",
    );
    expect(recordField(dispatcherOptions.proxyTls, "dispatcher.options.proxyTls").ca).toBe(
      "discord-rest-managed-proxy-ca",
    );
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("falls back to direct REST fetch when env proxy options are invalid", async () => {
    vi.stubEnv("https_proxy", "bad-proxy");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const fetcher = resolveDiscordRestFetch(undefined, runtime);
    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    expect(envHttpProxyAgentSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const agentOptions = objectArgAt(agentSpy, 0, 0);
    expect(agentOptions.allowH2).toBe(false);
    expect(typeof recordField(agentOptions.connect, "connect").lookup).toBe("function");
    expect(String(argAt(runtime.error, 0, 0))).toContain("bad env proxy");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("uses debug proxy env when no discord proxy URL is configured", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "http://127.0.0.1:7777");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const fetcher = resolveDiscordRestFetch(undefined, runtime);
    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    const proxyOptions = objectArgAt(proxyAgentSpy, 0, 0);
    expect(proxyOptions.uri).toBe("http://127.0.0.1:7777");
    expect(proxyOptions.allowH2).toBe(false);
    expect(runtime.log).toHaveBeenCalledWith("discord: rest proxy enabled");
  });
});
