import { afterAll, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";

const env = makeIsolatedEnv();

afterAll(() => {
  resetPluginAutoEnableTestState();
});

describe("applyPluginAutoEnable providers", () => {
  it("auto-enables provider auth plugins when profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "google-gemini-cli:default": {
              provider: "google-gemini-cli",
              mode: "oauth",
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
  });

  it("auto-enables bundled provider plugins when plugin-owned web search config exists", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-config-key",
                },
              },
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.xai?.enabled).toBe(true);
    expect(result.changes).toContain("xai web search configured, enabled automatically.");
  });

  it("auto-enables xai when the plugin-owned x_search tool is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                xSearch: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.xai?.enabled).toBe(true);
    expect(result.changes).toContain("xai tool configured, enabled automatically.");
  });

  it("auto-enables xai when the plugin-owned codeExecution config is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                codeExecution: {
                  enabled: true,
                  model: "grok-4-1-fast",
                },
              },
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.xai?.enabled).toBe(true);
    expect(result.changes).toContain("xai tool configured, enabled automatically.");
  });

  it("auto-enables minimax when minimax-portal profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "minimax-portal:default": {
              provider: "minimax-portal",
              mode: "oauth",
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.minimax?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["minimax-portal-auth"]).toBeUndefined();
  });

  it("auto-enables minimax when minimax API key auth is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "minimax:default": {
              provider: "minimax",
              mode: "api_key",
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.minimax?.enabled).toBe(true);
  });

  it("does not auto-enable unrelated provider plugins just because auth profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "api_key",
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.openai).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("uses manifest-owned provider auto-enable metadata for third-party plugins", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "acme-oauth:default": {
              provider: "acme-oauth",
              mode: "oauth",
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "acme",
          channels: [],
          autoEnableWhenConfiguredProviders: ["acme-oauth"],
        },
      ]),
    });

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
  });

  it("auto-enables third-party provider plugins when manifest-owned web search config exists", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          entries: {
            acme: {
              config: {
                webSearch: {
                  apiKey: "acme-search-key",
                },
              },
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "acme",
          channels: [],
          providers: ["acme-ai"],
          contracts: {
            webSearchProviders: ["acme-search"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
    expect(result.changes).toContain("acme web search configured, enabled automatically.");
  });

  it("auto-enables third-party plugins when manifest-owned tool config exists", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          entries: {
            acme: {
              config: {
                acmeTool: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "acme",
          channels: [],
          contracts: {
            tools: ["acme_tool"],
          },
          configSchema: {
            type: "object",
            properties: {
              webSearch: { type: "object" },
              acmeTool: { type: "object" },
            },
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
    expect(result.changes).toContain("acme tool configured, enabled automatically.");
  });

  it("auto-enables acpx plugin when ACP is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        acp: {
          enabled: true,
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.acpx?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("ACP runtime configured, enabled automatically.");
  });

  it("does not auto-enable acpx when a different ACP backend is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        acp: {
          enabled: true,
          backend: "custom-runtime",
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.acpx?.enabled).toBeUndefined();
  });
});
