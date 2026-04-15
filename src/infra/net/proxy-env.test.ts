import { describe, expect, it } from "vitest";
import {
  hasEnvHttpProxyConfigured,
  hasProxyEnvConfigured,
  matchesNoProxy,
  resolveEnvHttpProxyUrl,
} from "./proxy-env.js";

describe("hasProxyEnvConfigured", () => {
  it.each([
    {
      name: "detects upper-case HTTP proxy values",
      env: { HTTP_PROXY: "http://upper-http.test:8080" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "detects lower-case all_proxy values",
      env: { all_proxy: "socks5://proxy.test:1080" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "ignores blank proxy values",
      env: { HTTP_PROXY: "   ", all_proxy: "" } as NodeJS.ProcessEnv,
      expected: false,
    },
  ])("$name", ({ env, expected }) => {
    expect(hasProxyEnvConfigured(env)).toBe(expected);
  });
});

describe("resolveEnvHttpProxyUrl", () => {
  it.each([
    {
      name: "uses lower-case https_proxy before upper-case HTTPS_PROXY",
      protocol: "https" as const,
      env: {
        https_proxy: "http://lower.test:8080",
        HTTPS_PROXY: "http://upper.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: "http://lower.test:8080",
      expectedConfigured: true,
    },
    {
      name: "treats empty lower-case https_proxy as authoritative over upper-case HTTPS_PROXY",
      protocol: "https" as const,
      env: {
        https_proxy: "",
        HTTPS_PROXY: "http://upper.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "treats empty lower-case http_proxy as authoritative over upper-case HTTP_PROXY",
      protocol: "http" as const,
      env: {
        http_proxy: "   ",
        HTTP_PROXY: "http://upper-http.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "falls back from HTTPS proxy vars to HTTP proxy vars for https requests",
      protocol: "https" as const,
      env: {
        HTTP_PROXY: "http://upper-http.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: "http://upper-http.test:8080",
      expectedConfigured: true,
    },
    {
      name: "does not use ALL_PROXY for EnvHttpProxyAgent-style resolution",
      protocol: "https" as const,
      env: {
        ALL_PROXY: "http://all-proxy.test:8080",
        all_proxy: "http://lower-all-proxy.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "returns only HTTP proxies for http requests",
      protocol: "http" as const,
      env: {
        https_proxy: "http://lower-https.test:8080",
        http_proxy: "http://lower-http.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: "http://lower-http.test:8080",
      expectedConfigured: true,
    },
  ])("$name", ({ protocol, env, expectedUrl, expectedConfigured }) => {
    expect(resolveEnvHttpProxyUrl(protocol, env)).toBe(expectedUrl);
    expect(hasEnvHttpProxyConfigured(protocol, env)).toBe(expectedConfigured);
  });
});

describe("matchesNoProxy", () => {
  it.each([
    {
      name: "returns false when no NO_PROXY is set",
      url: "https://api.openai.com/v1/chat",
      env: {} as NodeJS.ProcessEnv,
      expected: false,
    },
    {
      name: "returns false for blank NO_PROXY",
      url: "https://api.openai.com",
      env: { NO_PROXY: "   " } as NodeJS.ProcessEnv,
      expected: false,
    },
    {
      name: "matches wildcard",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: "*" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches exact hostname",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: "api.openai.com" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches subdomain via leading-dot normalization",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: ".openai.com" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches subdomain suffix without leading dot",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: "openai.com" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "does not match unrelated hostname",
      url: "https://api.example.org/v1/chat",
      env: { NO_PROXY: "openai.com" } as NodeJS.ProcessEnv,
      expected: false,
    },
    {
      name: "does not match when suffix is not a domain boundary",
      url: "https://notopenai.com/v1",
      env: { NO_PROXY: "openai.com" } as NodeJS.ProcessEnv,
      expected: false,
    },
    {
      name: "respects port in NO_PROXY entry",
      url: "https://api.internal:8443/v1",
      env: { NO_PROXY: "api.internal:8443" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "does not match when port differs",
      url: "https://api.internal:9000/v1",
      env: { NO_PROXY: "api.internal:8443" } as NodeJS.ProcessEnv,
      expected: false,
    },
    {
      name: "is case-insensitive",
      url: "https://API.OpenAI.COM/v1",
      env: { no_proxy: "api.openai.com" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "parses comma-separated list",
      url: "https://internal.corp.example",
      env: { NO_PROXY: "localhost,127.0.0.1,internal.corp.example" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "parses whitespace-separated list (undici tokenizes on [,\\s])",
      url: "https://foo.corp.internal",
      env: { NO_PROXY: "localhost *.corp.internal" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "parses mixed comma-and-whitespace list",
      url: "https://api.openai.com",
      env: { NO_PROXY: "localhost, 127.0.0.1\tapi.openai.com" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "tab and newline act as delimiters",
      url: "https://internal.example",
      env: { NO_PROXY: "localhost\n127.0.0.1\tinternal.example" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches subdomain via *. wildcard normalization",
      url: "https://foo.example.com/v1",
      env: { NO_PROXY: "*.example.com" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "wildcard *.example.com matches bare example.com (undici normalizes to base domain)",
      url: "https://example.com/v1",
      env: { NO_PROXY: "*.example.com" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "*. wildcard respects port",
      url: "https://api.corp.internal:8443",
      env: { NO_PROXY: "*.corp.internal:8443" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "*. wildcard does not match unrelated suffix",
      url: "https://api.example.org",
      env: { NO_PROXY: "*.example.com" } as NodeJS.ProcessEnv,
      expected: false,
    },
    {
      name: "lower-case no_proxy is honored",
      url: "https://corp.local",
      env: { no_proxy: "corp.local" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches bracketed IPv6 literal",
      url: "http://[::1]:8080/health",
      env: { NO_PROXY: "[::1]:8080" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "returns false for malformed target URL",
      url: "not-a-url",
      env: { NO_PROXY: "*" } as NodeJS.ProcessEnv,
      expected: false,
    },
  ])("$name", ({ url, env, expected }) => {
    expect(matchesNoProxy(url, env)).toBe(expected);
  });
});
