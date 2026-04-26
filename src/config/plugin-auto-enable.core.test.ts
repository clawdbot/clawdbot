import { afterAll, describe, expect, it } from "vitest";
import {
  applyPluginAutoEnable,
  detectPluginAutoEnableCandidates,
  materializePluginAutoEnableCandidates,
  resolvePluginAutoEnableCandidateReason,
} from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import { validateConfigObject } from "./validation.js";

const env = makeIsolatedEnv();

afterAll(() => {
  resetPluginAutoEnableTestState();
});

describe("applyPluginAutoEnable core", () => {
  it("detects typed channel-configured candidates", () => {
    const candidates = detectPluginAutoEnableCandidates({
      config: {
        channels: { slack: { botToken: "x" } },
      },
      env,
    });

    expect(candidates).toEqual([
      {
        pluginId: "slack",
        kind: "channel-configured",
        channelId: "slack",
      },
    ]);
  });

  it("formats typed provider-auth candidates into stable reasons", () => {
    expect(
      resolvePluginAutoEnableCandidateReason({
        pluginId: "google",
        kind: "provider-auth-configured",
        providerId: "google",
      }),
    ).toBe("google auth configured");
  });

  it("treats an undefined config as empty", () => {
    const result = applyPluginAutoEnable({
      config: undefined,
      env,
    });

    expect(result.config).toEqual({});
    expect(result.changes).toEqual([]);
    expect(result.autoEnabledReasons).toEqual({});
  });

  it("auto-enables built-in channels and preserves them in restrictive plugins.allow", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: ["telegram"] },
      },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram", "slack"]);
    expect(result.autoEnabledReasons).toEqual({
      slack: ["slack configured"],
    });
    expect(result.changes.join("\n")).toContain("Slack configured, enabled automatically.");
  });

  it("does not create plugins.allow when allowlist is unset", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
      },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toBeUndefined();
  });

  it("stores auto-enable reasons in a null-prototype dictionary", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
      },
      env,
    });

    expect(Object.getPrototypeOf(result.autoEnabledReasons)).toBeNull();
  });

  it("materializes setup auto-enable candidates under a restrictive plugins.allow", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
      candidates: [
        {
          pluginId: "browser",
          kind: "setup-auto-enable",
          reason: "browser configured",
        },
      ],
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram", "browser"]);
    expect(result.config.plugins?.entries?.browser?.enabled).toBe(true);
    expect(result.changes).toContain("browser configured, enabled automatically.");
  });

  it("materializes setup auto-enable tool-reference reasons", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
      candidates: [
        {
          pluginId: "browser",
          kind: "setup-auto-enable",
          reason: "browser tool referenced",
        },
      ],
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram", "browser"]);
    expect(result.config.plugins?.entries?.browser?.enabled).toBe(true);
    expect(result.changes).toContain("browser tool referenced, enabled automatically.");
  });

  it("keeps restrictive plugins.allow unchanged when browser is not referenced", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram"]);
    expect(result.config.plugins?.entries?.browser).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("does not auto-enable or allowlist non-bundled web fetch providers from config", () => {
    const result = applyPluginAutoEnable({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "evilfetch",
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
          id: "evil-plugin",
          channels: [],
          contracts: { webFetchProviders: ["evilfetch"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.["evil-plugin"]).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram"]);
    expect(result.changes).toEqual([]);
  });

  it("auto-enables bundled firecrawl when plugin-owned webFetch config exists", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: "firecrawl-key",
                },
              },
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "firecrawl"]);
    expect(result.changes).toContain("firecrawl web fetch configured, enabled automatically.");
  });

  it("auto-enables an opt-in provider plugin when an explicit provider model is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "codex/gpt-5.4",
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([{ id: "codex", channels: [], providers: ["codex"] }]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toBeUndefined();
    expect(result.changes).toContain("codex/gpt-5.4 model configured, enabled automatically.");
  });

  it("does not auto-enable Codex when only the OpenAI plugin is explicitly enabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["openai"],
          entries: {
            openai: { enabled: true },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai", "openai-codex"] },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["openai"]);
    expect(result.changes).toEqual([]);
  });

  it("keeps OpenAI Codex OAuth model refs owned by the OpenAI plugin", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai", "openai-codex"] },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.codex).toBeUndefined();
    expect(result.changes).toEqual([
      "openai-codex/gpt-5.5 model configured, enabled automatically.",
    ]);
  });

  it("auto-enables Codex only for the native Codex harness with OpenAI model refs", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            agentRuntime: {
              id: "codex",
              fallback: "none",
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai", "openai-codex"] },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.changes).toEqual([
      "openai/gpt-5.5 model configured, enabled automatically.",
      "codex agent runtime configured, enabled automatically.",
    ]);
  });

  it("auto-enables an opt-in plugin when an agent runtime is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            agentRuntime: {
              id: "codex",
              fallback: "none",
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "codex",
          channels: [],
          activation: {
            onAgentHarnesses: ["codex"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.changes).toContain("codex agent runtime configured, enabled automatically.");
  });

  it("auto-enables a CLI backend owner when an agent runtime is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            agentRuntime: {
              id: "claude-cli",
              fallback: "none",
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
          id: "anthropic",
          channels: [],
          providers: ["anthropic"],
          cliBackends: ["claude-cli"],
        },
      ]),
    });

    expect(result.config.plugins?.entries?.anthropic?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "anthropic"]);
    expect(result.changes).toContain("claude-cli agent runtime configured, enabled automatically.");
  });

  it("auto-enables an opt-in plugin when an agent harness runtime is forced by env", () => {
    const result = applyPluginAutoEnable({
      config: {},
      env: makeIsolatedEnv({ OPENCLAW_AGENT_RUNTIME: "codex" }),
      manifestRegistry: makeRegistry([
        {
          id: "codex",
          channels: [],
          activation: {
            onAgentHarnesses: ["codex"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.changes).toContain("codex agent runtime configured, enabled automatically.");
  });

  it("skips auto-enable work for configs without channel or plugin-owned surfaces", () => {
    const result = applyPluginAutoEnable({
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: "ok",
          },
        },
        agents: {
          list: [{ id: "pi" }],
        },
      },
      env,
    });

    expect(result.config).toEqual({
      gateway: {
        auth: {
          mode: "token",
          token: "ok",
        },
      },
      agents: {
        list: [{ id: "pi" }],
      },
    });
    expect(result.changes).toEqual([]);
  });

  it("ignores channels.modelByChannel for plugin auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          modelByChannel: {
            openai: {
              whatsapp: "openai/gpt-5.4",
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.modelByChannel).toBeUndefined();
    expect(result.config.plugins?.allow).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("keeps auto-enabled WhatsApp config schema-valid", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
      },
      env,
    });

    expect(result.config.channels?.whatsapp?.enabled).toBe(true);
    expect(validateConfigObject(result.config).ok).toBe(true);
  });

  it("appends built-in WhatsApp to restrictive plugins.allow during auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
    });

    expect(result.config.channels?.whatsapp?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "whatsapp"]);
    expect(validateConfigObject(result.config).ok).toBe(true);
  });

  it("preserves configured plugin entries in restrictive plugins.allow", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["glueclaw"],
          entries: {
            discord: {
              config: {
                token: "x",
              },
            },
          },
        },
      },
      candidates: [],
      env,
      manifestRegistry: makeRegistry([{ id: "discord", channels: [] }]),
    });

    expect(result.config.plugins?.allow).toEqual(["glueclaw", "discord"]);
    expect(result.changes).toContain("discord plugin config present, added to plugin allowlist.");
  });

  it("does not preserve stale configured plugin entries in restrictive plugins.allow", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["glueclaw"],
          entries: {
            "missing-plugin": {
              config: {
                token: "x",
              },
            },
          },
        },
      },
      candidates: [],
      env,
      manifestRegistry: makeRegistry([]),
    });

    expect(result.config.plugins?.allow).toEqual(["glueclaw"]);
    expect(result.changes).toEqual([]);
  });

  it("does not re-emit built-in auto-enable changes when rerun with plugins.allow set", () => {
    const first = applyPluginAutoEnable({
      config: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
    });

    const second = applyPluginAutoEnable({
      config: first.config,
      env,
    });

    expect(first.changes).toHaveLength(1);
    expect(second.changes).toEqual([]);
    expect(second.config).toEqual(first.config);
  });

  it("respects explicit disable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { entries: { slack: { enabled: false } } },
      },
      env,
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it("respects built-in channel explicit disable via channels.<id>.enabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x", enabled: false } },
      },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("does not auto-enable plugin channels when only enabled=false is set", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { matrix: { enabled: false } },
      },
      env,
      manifestRegistry: makeRegistry([{ id: "matrix", channels: ["matrix"] }]),
    });

    expect(result.config.plugins?.entries?.matrix).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("auto-enables irc when configured via env", () => {
    const result = applyPluginAutoEnable({
      config: {},
      env: {
        ...makeIsolatedEnv(),
        IRC_HOST: "irc.libera.chat",
        IRC_NICK: "openclaw-bot",
      },
    });

    expect(result.config.channels?.irc?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("IRC configured, enabled automatically.");
  });

  it("uses the provided manifest registry for plugin channel ids", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { apn: { someKey: "value" } },
      },
      env,
      manifestRegistry: makeRegistry([{ id: "apn-channel", channels: ["apn"] }]),
    });

    expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.apn).toBeUndefined();
  });

  it("skips when plugins are globally disabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { enabled: false },
      },
      env,
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBeUndefined();
    expect(result.changes).toEqual([]);
  });
});
