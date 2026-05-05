import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { undiciFetchMock, agentSpy, proxyAgentSpy } = vi.hoisted(() => ({
  undiciFetchMock: vi.fn(),
  agentSpy: vi.fn(),
  proxyAgentSpy: vi.fn(),
}));

vi.mock("undici", () => {
  class Agent {
    options: unknown;
    constructor(options?: unknown) {
      this.options = options;
      agentSpy(options);
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
    ProxyAgent,
    fetch: undiciFetchMock,
  };
});

let resolveDiscordRestFetch: typeof import("./rest-fetch.js").resolveDiscordRestFetch;

describe("resolveDiscordRestFetch", () => {
  beforeAll(async () => {
    ({ resolveDiscordRestFetch } = await import("./rest-fetch.js"));
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    undiciFetchMock.mockReset();
    agentSpy.mockReset();
    proxyAgentSpy.mockReset();
  });

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

    expect(proxyAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "http://127.0.0.1:8080",
        allowH2: false,
      }),
    );
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/applications/@me",
      expect.objectContaining({
        dispatcher: expect.objectContaining({
          uri: "http://127.0.0.1:8080",
          options: expect.objectContaining({ allowH2: false }),
        }),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: rest proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to global fetch when proxy URL is invalid", async () => {
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
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("loopback host"));
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

    expect(proxyAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "http://[::1]:8080",
        allowH2: false,
      }),
    );
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

    expect(agentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowH2: false,
        connect: expect.objectContaining({ lookup: expect.any(Function) }),
      }),
    );
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/applications/@me",
      expect.objectContaining({
        dispatcher: expect.objectContaining({
          options: expect.objectContaining({
            allowH2: false,
            connect: expect.objectContaining({ lookup: expect.any(Function) }),
          }),
        }),
      }),
    );
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

    expect(proxyAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "http://127.0.0.1:7777",
        allowH2: false,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: rest proxy enabled");
  });
});
