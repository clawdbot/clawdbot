import { afterAll, describe, expect, it } from "vitest";
import {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "./plugin-auto-enable.js";
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
      manifestRegistry: makeRegistry([
        {
          id: "google",
          channels: [],
          autoEnableWhenConfiguredProviders: ["google-gemini-cli"],
        },
      ]),
    });

    expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
  });

  it("auto-enables provider plugins when plugin-owned web search config exists", () => {
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
      manifestRegistry: makeRegistry([
        {
          id: "xai",
          channels: [],
          providers: ["xai"],
          contracts: {
            webSearchProviders: ["grok"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.xai?.enabled).toBe(true);
    expect(result.changes).toContain("xai web search configured, enabled automatically.");
  });

  it("auto-enables selected web search provider plugins under restrictive allowlists", () => {
    const result = applyPluginAutoEnable({
      config: {
        tools: {
          web: {
            search: {
              provider: "brave",
            },
          },
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "brave",
          channels: [],
          contracts: {
            webSearchProviders: ["brave"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.brave?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "brave"]);
    expect(result.changes).toContain("brave web search provider selected, enabled automatically.");
  });

  it("does not auto-enable selected web search provider plugins when web search is disabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "brave",
            },
          },
        },
        plugins: {
          allow: ["telegram"],
        },
        agents: {
          defaults: {
            model: "codex/gpt-5.4",
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "brave",
          channels: [],
          contracts: {
            webSearchProviders: ["brave"],
          },
        },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.brave).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram", "codex"]);
    expect(result.changes).toContain("codex/gpt-5.4 model configured, enabled automatically.");
    expect(result.changes).not.toContain(
      "brave web search provider selected, enabled automatically.",
    );
  });

  it("materializes xai setup auto-enable when the plugin-owned x_search tool is configured", () => {
    const result = materializePluginAutoEnableCandidates({
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
      candidates: [
        {
          pluginId: "xai",
          kind: "setup-auto-enable",
          reason: "xai tool configured",
        },
      ],
      env,
      manifestRegistry: makeRegistry([{ id: "xai", channels: [] }]),
    });

    expect(result.config.plugins?.entries?.xai?.enabled).toBe(true);
    expect(result.changes).toContain("xai tool configured, enabled automatically.");
  });

  it("materializes xai setup auto-enable when the plugin-owned codeExecution config is configured", () => {
    const result = materializePluginAutoEnableCandidates({
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
      candidates: [
        {
          pluginId: "xai",
          kind: "setup-auto-enable",
          reason: "xai tool configured",
        },
      ],
      env,
      manifestRegistry: makeRegistry([{ id: "xai", channels: [] }]),
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
      manifestRegistry: makeRegistry([
        {
          id: "minimax",
          channels: [],
          autoEnableWhenConfiguredProviders: ["minimax-portal"],
        },
      ]),
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
      manifestRegistry: makeRegistry([
        {
          id: "minimax",
          channels: [],
          autoEnableWhenConfiguredProviders: ["minimax"],
        },
      ]),
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
      manifestRegistry: makeRegistry([]),
    });

    expect(result.config.plugins?.entries?.openai).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
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

  it("materializes acpx setup auto-enable when ACP is configured", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        acp: {
          enabled: true,
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      candidates: [
        {
          pluginId: "acpx",
          kind: "setup-auto-enable",
          reason: "ACP runtime configured",
        },
      ],
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram", "acpx"]);
    expect(result.config.plugins?.entries?.acpx?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("ACP runtime configured, enabled automatically.");
  });

  it("does not materialize acpx when no setup auto-enable candidate is present", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        acp: {
          enabled: true,
          backend: "custom-runtime",
        },
      },
      candidates: [],
      env,
    });

    expect(result.config.plugins?.entries?.acpx?.enabled).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });
});
