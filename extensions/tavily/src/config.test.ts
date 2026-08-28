import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowsTavilyKeyless,
  DEFAULT_TAVILY_BASE_URL,
  resolveTavilyApiKey,
  resolveTavilyCredential,
  resolveTavilyRequestAuth,
} from "./config.js";

function configWithApiKey(apiKey: unknown, extra?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    ...extra,
    plugins: {
      entries: {
        tavily: {
          config: {
            webSearch: {
              apiKey,
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function withoutTavilyEnv() {
  vi.stubEnv("TAVILY_API_KEY", "");
  vi.stubEnv("TAVILY_BASE_URL", "");
}

describe("resolveTavilyApiKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to process.env.TAVILY_API_KEY for a matching unresolved env SecretRef", () => {
    vi.stubEnv("TAVILY_API_KEY", "dummy");

    expect(
      resolveTavilyApiKey(
        configWithApiKey({
          source: "env",
          provider: "default",
          id: "TAVILY_API_KEY",
        }),
      ),
    ).toBe("dummy");
  });

  it("allows a configured env provider when its allowlist includes TAVILY_API_KEY", () => {
    vi.stubEnv("TAVILY_API_KEY", "dummy");

    expect(
      resolveTavilyApiKey(
        configWithApiKey(
          {
            source: "env",
            provider: "managed-env",
            id: "TAVILY_API_KEY",
          },
          {
            secrets: {
              providers: {
                "managed-env": {
                  source: "env",
                  allowlist: ["TAVILY_API_KEY"],
                },
              },
            },
          } as Partial<OpenClawConfig>,
        ),
      ),
    ).toBe("dummy");
  });

  it.each([
    {
      name: "file SecretRef",
      apiKey: {
        source: "file",
        provider: "default",
        id: "/etc/secrets/tavily",
      },
    },
    {
      name: "exec SecretRef",
      apiKey: {
        source: "exec",
        provider: "default",
        id: "TAVILY_API_KEY",
      },
    },
    {
      name: "different env id",
      apiKey: {
        source: "env",
        provider: "default",
        id: "OTHER_API_KEY",
      },
    },
    {
      name: "env provider with a blocking allowlist",
      apiKey: {
        source: "env",
        provider: "managed-env",
        id: "TAVILY_API_KEY",
      },
      extra: {
        secrets: {
          providers: {
            "managed-env": {
              source: "env",
              allowlist: [],
            },
          },
        },
      } as Partial<OpenClawConfig>,
    },
  ])("does not fall back to process.env.TAVILY_API_KEY for $name", ({ apiKey, extra }) => {
    vi.stubEnv("TAVILY_API_KEY", "dummy");

    expect(resolveTavilyApiKey(configWithApiKey(apiKey, extra))).toBeUndefined();
    expect(resolveTavilyCredential(configWithApiKey(apiKey, extra))).toEqual({ status: "blocked" });
  });
});

describe("resolveTavilyCredential", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports missing when no key is configured", () => {
    withoutTavilyEnv();
    expect(resolveTavilyCredential()).toEqual({ status: "missing" });
  });

  it("reports available from TAVILY_API_KEY", () => {
    vi.stubEnv("TAVILY_API_KEY", "dummy");
    expect(resolveTavilyCredential()).toEqual({ status: "available", value: "dummy" });
  });
});

describe("allowsTavilyKeyless", () => {
  it("allows the default Tavily origin including path prefixes", () => {
    expect(allowsTavilyKeyless(DEFAULT_TAVILY_BASE_URL)).toBe(true);
    expect(allowsTavilyKeyless("https://api.tavily.com/proxy")).toBe(true);
  });

  it("rejects a custom origin", () => {
    expect(allowsTavilyKeyless("https://proxy.example/tavily")).toBe(false);
    expect(allowsTavilyKeyless("not a url")).toBe(false);
  });
});

describe("resolveTavilyRequestAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses keyless on the default Tavily host when no key is configured", () => {
    withoutTavilyEnv();
    expect(resolveTavilyRequestAuth(undefined, "search")).toEqual({ mode: "keyless" });
    expect(resolveTavilyRequestAuth(undefined, "extract")).toEqual({ mode: "keyless" });
  });

  it("uses keyed auth when a key is available", () => {
    vi.stubEnv("TAVILY_API_KEY", "dummy");
    expect(resolveTavilyRequestAuth(undefined, "search")).toEqual({
      mode: "keyed",
      apiKey: "dummy",
    });
  });

  it("fails closed when the SecretRef is blocked", () => {
    vi.stubEnv("TAVILY_API_KEY", "dummy");
    expect(() =>
      resolveTavilyRequestAuth(
        configWithApiKey({
          source: "file",
          provider: "default",
          id: "/etc/secrets/tavily",
        }),
        "search",
      ),
    ).toThrow(/credential is configured but unavailable/);
  });

  it("requires a key for a custom base URL", () => {
    withoutTavilyEnv();
    expect(() =>
      resolveTavilyRequestAuth(
        {
          plugins: {
            entries: {
              tavily: {
                config: {
                  webSearch: {
                    baseUrl: "https://proxy.example/tavily",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        "extract",
      ),
    ).toThrow(/custom base URL/);
  });
});
