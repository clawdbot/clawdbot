// Node HTTP proxy tests cover proxy agent creation for provider requests.
import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createHttpProxyAgentsForTarget } from "./node-http-proxy.js";

const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE = "Unsupported proxy protocol.";

const PROXY_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
] as const;

function withProxyEnv<T>(
  env: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>>,
  fn: () => T,
): T {
  const clearedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, undefined])) as Record<
    (typeof PROXY_ENV_KEYS)[number],
    undefined
  >;
  return withEnv({ ...clearedEnv, ...env }, fn);
}

function resolveProxyFromAgents(target: string): string | undefined {
  const agent = createHttpProxyAgentsForTarget(target)?.httpsAgent as
    | { getProxyForUrl?: (url: string) => string }
    | undefined;
  return agent?.getProxyForUrl?.(target);
}

describe("node HTTP proxy resolution", () => {
  it("honors unbracketed IPv6 literals in NO_PROXY", () => {
    withProxyEnv({ HTTP_PROXY: "http://proxy.example:8080", NO_PROXY: "::1" }, () => {
      expect(createHttpProxyAgentsForTarget("http://[::1]:11434/v1")).toBeUndefined();
    });
  });

  it("honors bracketed IPv6 literals with matching NO_PROXY ports", () => {
    withProxyEnv({ HTTP_PROXY: "http://proxy.example:8080", NO_PROXY: "[::1]:11434" }, () => {
      expect(createHttpProxyAgentsForTarget("http://[::1]:11434/v1")).toBeUndefined();
      expect(resolveProxyFromAgents("http://[::1]:11435/v1")).toBe("http://proxy.example:8080/");
    });
  });

  it("honors default WebSocket ports in NO_PROXY", () => {
    withProxyEnv(
      { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "web.whatsapp.com:443" },
      () => {
        expect(createHttpProxyAgentsForTarget("wss://web.whatsapp.com/ws")).toBeUndefined();
      },
    );
  });

  it("does not mutate URL inputs when normalizing WebSocket targets", () => {
    withProxyEnv(
      { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "web.whatsapp.com:443" },
      () => {
        const target = new URL("wss://web.whatsapp.com/ws");

        expect(createHttpProxyAgentsForTarget(target)).toBeUndefined();
        expect(target.href).toBe("wss://web.whatsapp.com/ws");
      },
    );
  });

  it("uses Proxyline Node agents for resolved env proxies", () => {
    withProxyEnv({ HTTPS_PROXY: "http://proxy.example:8080" }, () => {
      const agents = createHttpProxyAgentsForTarget("https://api.example.test/v1");

      expect(agents?.httpsAgent.constructor.name).toBe("ProxylineNodeProxyAgent");
      expect(
        (
          agents?.httpsAgent as { getProxyForUrl?: (url: string) => string } | undefined
        )?.getProxyForUrl?.("https://api.example.test/v1"),
      ).toBe("http://proxy.example:8080/");
    });
  });

  it("falls back to ALL_PROXY for Node agent proxy resolution", () => {
    withProxyEnv({ ALL_PROXY: "http://proxy.example:8080" }, () => {
      expect(resolveProxyFromAgents("https://api.example.test/v1")).toBe(
        "http://proxy.example:8080/",
      );
    });
  });

  it("rejects unsupported env proxy protocols", () => {
    withProxyEnv({ HTTPS_PROXY: "socks5://proxy.example:1080" }, () => {
      expect(() => createHttpProxyAgentsForTarget("https://api.example.test/v1")).toThrow(
        UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
      );
    });
  });
});
