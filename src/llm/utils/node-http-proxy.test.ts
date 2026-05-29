import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpProxyAgentsForTarget,
  resolveHttpProxyUrlForTarget,
  UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
} from "./node-http-proxy.js";

function clearProxyEnv(): void {
  for (const key of [
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
  ]) {
    vi.stubEnv(key, undefined);
  }
}

describe("node HTTP proxy resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors unbracketed IPv6 literals in NO_PROXY", () => {
    clearProxyEnv();
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "::1");

    expect(resolveHttpProxyUrlForTarget("http://[::1]:11434/v1")).toBeUndefined();
  });

  it("honors bracketed IPv6 literals with matching NO_PROXY ports", () => {
    clearProxyEnv();
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "[::1]:11434");

    expect(resolveHttpProxyUrlForTarget("http://[::1]:11434/v1")).toBeUndefined();
    expect(resolveHttpProxyUrlForTarget("http://[::1]:11435/v1")?.href).toBe(
      "http://proxy.example:8080/",
    );
  });

  it("honors default WebSocket ports in NO_PROXY", () => {
    clearProxyEnv();
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "web.whatsapp.com:443");

    expect(resolveHttpProxyUrlForTarget("wss://web.whatsapp.com/ws")).toBeUndefined();
  });

  it("does not mutate URL inputs when normalizing WebSocket targets", () => {
    clearProxyEnv();
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "web.whatsapp.com:443");
    const target = new URL("wss://web.whatsapp.com/ws");

    expect(resolveHttpProxyUrlForTarget(target)).toBeUndefined();
    expect(target.href).toBe("wss://web.whatsapp.com/ws");
  });

  it("uses Proxyline Node agents for resolved env proxies", () => {
    clearProxyEnv();
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");

    const agents = createHttpProxyAgentsForTarget("https://api.example.test/v1");

    expect(agents?.httpsAgent.constructor.name).toBe("ProxylineNodeProxyAgent");
    expect(
      (
        agents?.httpsAgent as { getProxyForUrl?: (url: string) => string } | undefined
      )?.getProxyForUrl?.("https://api.example.test/v1"),
    ).toBe("http://proxy.example:8080/");
  });

  it("falls back to ALL_PROXY for Node agent proxy resolution", () => {
    clearProxyEnv();
    vi.stubEnv("ALL_PROXY", "http://proxy.example:8080");

    expect(resolveHttpProxyUrlForTarget("https://api.example.test/v1")?.href).toBe(
      "http://proxy.example:8080/",
    );
  });

  it("rejects unsupported env proxy protocols", () => {
    clearProxyEnv();
    vi.stubEnv("HTTPS_PROXY", "socks5://proxy.example:1080");

    expect(() => resolveHttpProxyUrlForTarget("https://api.example.test/v1")).toThrow(
      UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
    );
  });
});
