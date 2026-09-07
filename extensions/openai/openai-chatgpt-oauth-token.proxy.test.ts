import { once } from "node:events";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const directLookup = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("direct DNS selected");
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({ ...params, lookupFn: directLookup }),
  };
});

import {
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";

afterEach(() => {
  directLookup.mockClear();
  vi.unstubAllEnvs();
});

describe.each(["exchange", "refresh"] as const)("OpenAI token %s proxy routing", (operation) => {
  it.each([
    { name: "HTTPS_PROXY", variable: "HTTPS_PROXY", proxied: true },
    { name: "HTTP_PROXY fallback", variable: "HTTP_PROXY", proxied: true },
    {
      name: "NO_PROXY bypass",
      variable: "HTTPS_PROXY",
      noProxy: "auth.openai.com",
      proxied: false,
    },
    { name: "no configured proxy", proxied: false },
    { name: "ALL_PROXY alone", variable: "ALL_PROXY", proxied: false },
    { name: "empty lowercase override", variable: "HTTPS_PROXY", lowerEmpty: true, proxied: false },
    { name: "managed proxy", variable: "HTTPS_PROXY", managed: true, proxied: true },
    { name: "retired owner", variable: "HTTPS_PROXY", retired: true, proxied: false },
    { name: "aborted caller", variable: "HTTPS_PROXY", aborted: true, proxied: false },
  ])("preserves $name behavior", async (scenario) => {
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
      "OPENCLAW_PROXY_ACTIVE",
      "OPENCLAW_DEBUG_PROXY_ENABLED",
    ]) {
      vi.stubEnv(key, undefined);
    }
    const destinations: string[] = [];
    const sockets = new Set<Duplex>();
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      destinations.push(request.url ?? "");
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // A rejected CONNECT proves proxy selection without contacting an auth service.
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP proxy address");
    }
    if (scenario.variable) {
      vi.stubEnv(scenario.variable, `http://127.0.0.1:${address.port}`);
    }
    vi.stubEnv("NO_PROXY", scenario.noProxy ?? "");
    if (scenario.lowerEmpty) {
      vi.stubEnv("https_proxy", "");
    }
    if (scenario.managed) {
      vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    }
    const controller = new AbortController();
    if (scenario.aborted) {
      controller.abort();
    }
    const assertCurrent = vi.fn(() => {
      if (scenario.retired) {
        throw new Error("owner retired");
      }
    });
    const options = { signal: controller.signal, assertCurrent, timeoutMs: 1000 };

    try {
      const result =
        operation === "exchange"
          ? await exchangeOpenAIAuthorizationCode(
              "synthetic-code",
              "synthetic-verifier",
              "http://localhost:1455/auth/callback",
              options,
            )
          : await refreshOpenAIAccessToken("synthetic-refresh", options);

      expect(result).toMatchObject({ type: "failed", operation });
      expect(destinations).toEqual(scenario.proxied ? ["auth.openai.com:443"] : []);
      if (scenario.aborted) {
        expect(result).toMatchObject({ cancelled: true, summary: "Login cancelled" });
        expect(assertCurrent).not.toHaveBeenCalled();
      } else if (scenario.retired) {
        expect(result).toMatchObject({ summary: expect.stringContaining("owner retired") });
        expect(assertCurrent).toHaveBeenCalledOnce();
      } else if (scenario.proxied) {
        expect(assertCurrent).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({ summary: expect.stringContaining("direct DNS selected") });
      }
      expect(directLookup).toHaveBeenCalledTimes(
        scenario.proxied || scenario.retired || scenario.aborted ? 0 : 1,
      );
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
      });
    }
  });
});
