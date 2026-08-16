import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTavilyApiKey } from "./config.js";

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
  });
});
