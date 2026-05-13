import { describe, expect, it } from "vitest";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "./config-paths.js";
import { readConfigFileSnapshot } from "./config.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { buildWebSearchProviderConfig, withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import { validateConfigObject, validateConfigObjectRaw } from "./validation.js";
import { OpenClawSchema } from "./zod-schema.js";

const nonBooleanConfigCases = [
  {
    name: "gateway.controlUi.allowExternalEmbedUrls",
    config: {
      gateway: {
        controlUi: {
          allowExternalEmbedUrls: "yes",
        },
      },
    },
  },
  {
    name: "plugins.entries.*.hooks.allowPromptInjection",
    config: {
      plugins: {
        entries: {
          "voice-call": {
            hooks: {
              allowPromptInjection: "no",
              allowConversationAccess: true,
            },
          },
        },
      },
    },
  },
];

function issuePaths(issues: Array<{ path: string }>): string[] {
  return issues.map((issue) => issue.path);
}

function issueMessages(issues: Array<{ message: string }>): string[] {
  return issues.map((issue) => issue.message);
}

function expectSomeIssueMessageContains(issues: Array<{ message: string }>, text: string): void {
  expect(issueMessages(issues).join("\n")).toContain(text);
}

describe("boolean config validation", () => {
  it.each(nonBooleanConfigCases)("rejects non-boolean values for $name", ({ config }) => {
    const result = OpenClawSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("model provider localService config", () => {
  it("accepts on-demand local provider service settings", () => {
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          ds4: {
            baseUrl: "http://127.0.0.1:18000/v1",
            api: "openai-completions",
            localService: {
              command: "/Users/me/ds4-server",
              args: ["--port", "18000"],
              cwd: "/Users/me/ds4",
              env: { METAL_DEVICE_WRAPPER_TYPE: "1" },
              healthUrl: "http://127.0.0.1:18000/v1/models",
              readyTimeoutMs: 180_000,
              idleStopMs: 0,
            },
            models: [],
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("$schema key in config (#14998)", () => {
  it("accepts config with $schema string", () => {
    const result = OpenClawSchema.safeParse({
      $schema: "https://openclaw.ai/config.json",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.$schema).toBe("https://openclaw.ai/config.json");
    }
  });

  it("accepts config without $schema", () => {
    const result = OpenClawSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects non-string $schema", () => {
    const result = OpenClawSchema.safeParse({ $schema: 123 });
    expect(result.success).toBe(false);
  });

  it("accepts $schema during full config validation", () => {
    const result = validateConfigObject({
      $schema: "./schema.json",
      gateway: { port: 18789 },
    });
    expect(result.ok).toBe(true);
  });

  it("preserves $schema through validateConfigObject round-trip", () => {
    const res = validateConfigObject({
      $schema: "https://openclaw.ai/config.json",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.$schema).toBe("https://openclaw.ai/config.json");
    }
  });
});

describe("legacy Canvas host config", () => {
  it("keeps root canvasHost valid so doctor can migrate it", () => {
    const result = validateConfigObjectRaw({
      canvasHost: {
        enabled: false,
        root: "~/canvas",
        port: 18790,
        liveReload: false,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.config as { canvasHost?: unknown }).canvasHost).toEqual({
        enabled: false,
        root: "~/canvas",
        port: 18790,
        liveReload: false,
      });
    }
  });
});

describe("accessGroups config", () => {
  it("accepts Discord channel audience access groups", () => {
    const result = OpenClawSchema.safeParse({
      accessGroups: {
        maintainers: {
          type: "discord.channelAudience",
          guildId: "1456350064065904867",
          channelId: "1456744319972282449",
          membership: "canViewChannel",
        },
      },
      channels: {
        discord: {
          dmPolicy: "allowlist",
          allowFrom: ["accessGroup:maintainers"],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown access group membership modes", () => {
    const result = OpenClawSchema.safeParse({
      accessGroups: {
        maintainers: {
          type: "discord.channelAudience",
          guildId: "guild",
          channelId: "channel",
          membership: "roleMember",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts message sender access groups for any channel", () => {
    const result = OpenClawSchema.safeParse({
      accessGroups: {
        owners: {
          type: "message.senders",
          members: {
            "*": ["global-owner"],
            telegram: ["12345"],
            discord: ["discord:67890"],
          },
        },
      },
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["accessGroup:owners"],
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("plugins.slots.contextEngine", () => {
  it("accepts a contextEngine slot id", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        slots: {
          contextEngine: "my-context-engine",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("models.pricing", () => {
  it("accepts the model pricing bootstrap toggle", () => {
    for (const enabled of [true, false]) {
      const result = OpenClawSchema.safeParse({
        models: {
          pricing: { enabled },
        },
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects non-boolean model pricing bootstrap values", () => {
    const result = OpenClawSchema.safeParse({
      models: {
        pricing: { enabled: "false" },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("crestodian.rescue", () => {
  it("accepts documented rescue config", () => {
    const result = OpenClawSchema.safeParse({
      crestodian: {
        rescue: {
          enabled: "auto",
          ownerDmOnly: false,
          pendingTtlMinutes: 5,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts boolean rescue enablement", () => {
    const result = OpenClawSchema.safeParse({
      crestodian: {
        rescue: {
          enabled: true,
          ownerDmOnly: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown rescue keys", () => {
    const result = OpenClawSchema.safeParse({
      crestodian: {
        rescue: {
          enabled: true,
          shell: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("diagnostics.otel.captureContent", () => {
  it("accepts boolean and granular OTEL content capture config", () => {
    for (const captureContent of [
      true,
      false,
      {
        enabled: true,
        inputMessages: true,
        outputMessages: true,
        toolInputs: true,
        toolOutputs: true,
        systemPrompt: false,
      },
    ]) {
      const result = OpenClawSchema.safeParse({
        diagnostics: {
          otel: {
            captureContent,
          },
        },
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("auth.cooldowns auth_permanent backoff config", () => {
  it("accepts auth_permanent backoff knobs", () => {
    const result = OpenClawSchema.safeParse({
      auth: {
        cooldowns: {
          authPermanentBackoffMinutes: 10,
          authPermanentMaxMinutes: 60,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("ui.seamColor", () => {
  it("accepts hex colors", () => {
    const res = validateConfigObject({ ui: { seamColor: "#FF4500" } });
    expect(res.ok).toBe(true);
  });

  it("rejects non-hex colors", () => {
    const res = validateConfigObject({ ui: { seamColor: "lobster" } });
    expect(res.ok).toBe(false);
  });

  it("rejects invalid hex length", () => {
    const res = validateConfigObject({ ui: { seamColor: "#FF4500FF" } });
    expect(res.ok).toBe(false);
  });
});

describe("gateway.controlUi.embedSandbox", () => {
  it("accepts strict, scripts, and trusted modes", () => {
    for (const mode of ["strict", "scripts", "trusted"] as const) {
      const result = OpenClawSchema.safeParse({
        gateway: {
          controlUi: {
            embedSandbox: mode,
          },
        },
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects unsupported values", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        controlUi: {
          embedSandbox: "yolo",
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("gateway.controlUi.allowExternalEmbedUrls", () => {
  it("accepts boolean values", () => {
    for (const value of [true, false]) {
      const result = OpenClawSchema.safeParse({
        gateway: {
          controlUi: {
            allowExternalEmbedUrls: value,
          },
        },
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("gateway.controlUi.chatMessageMaxWidth", () => {
  it("accepts constrained CSS width values", () => {
    for (const value of ["960px", "82%", "min(1280px, 82%)", "calc(100% - 2rem)"]) {
      const result = OpenClawSchema.safeParse({
        gateway: {
          controlUi: {
            chatMessageMaxWidth: value,
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.gateway?.controlUi?.chatMessageMaxWidth).toBe(value);
      }
    }
  });

  it("normalizes whitespace around the width value", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        controlUi: {
          chatMessageMaxWidth: "  min(1280px,   82%)  ",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gateway?.controlUi?.chatMessageMaxWidth).toBe("min(1280px, 82%)");
    }
  });

  it("rejects arbitrary CSS injection", () => {
    for (const value of ["url(https://example.com/x)", "960px; color: red", "var(--x)"]) {
      const result = OpenClawSchema.safeParse({
        gateway: {
          controlUi: {
            chatMessageMaxWidth: value,
          },
        },
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("plugins.entries.*.hooks", () => {
  it.each([true, false])("accepts allowConversationAccess=%s", (allowConversationAccess) => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            hooks: {
              allowPromptInjection: false,
              allowConversationAccess,
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts allowPromptInjection=false alongside allowConversationAccess=true", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            hooks: {
              allowPromptInjection: false,
              allowConversationAccess: true,
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts bounded typed hook timeout overrides", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "memory-recall": {
            hooks: {
              timeoutMs: 30_000,
              timeouts: {
                before_prompt_build: 90_000,
                agent_end: 60_000,
              },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-boolean conversation access values", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            hooks: {
              allowPromptInjection: false,
              allowConversationAccess: "yes",
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid typed hook timeout overrides", () => {
    for (const hooks of [
      { timeoutMs: 0 },
      { timeoutMs: 600_001 },
      { timeouts: { before_prompt_build: -1 } },
      { timeouts: { before_prompt_build: 1.5 } },
    ]) {
      const result = OpenClawSchema.safeParse({
        plugins: {
          entries: {
            "memory-recall": { hooks },
          },
        },
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("plugins.entries.*.subagent", () => {
  it("accepts trusted subagent override settings", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid trusted subagent override settings", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: "yes",
              allowedModels: [1],
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("plugins.entries.*.llm", () => {
  it("accepts trusted llm override settings", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            llm: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
              allowAgentIdOverride: true,
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid trusted llm override settings", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            llm: {
              allowModelOverride: "yes",
              allowedModels: [1],
              allowAgentIdOverride: "yes",
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("web search provider config", () => {
  it("accepts kimi provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "kimi",
        providerConfig: {
          apiKey: "test-key",
          baseUrl: "https://api.moonshot.ai/v1",
          model: "moonshot-v1-128k",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });
});

describe("gateway.remote.transport", () => {
  it("accepts direct transport", () => {
    const res = validateConfigObject({
      gateway: {
        remote: {
          transport: "direct",
          url: "wss://gateway.example.ts.net",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown transport", () => {
    const res = validateConfigObject({
      gateway: {
        remote: {
          transport: "udp",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.remote.transport");
    }
  });
});

describe("gateway.tools config", () => {
  it("accepts gateway.tools allow and deny lists", () => {
    const res = validateConfigObject({
      gateway: {
        tools: {
          allow: ["gateway"],
          deny: ["sessions_spawn", "sessions_send"],
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects invalid gateway.tools values", () => {
    const res = validateConfigObject({
      gateway: {
        tools: {
          allow: "gateway",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.tools.allow");
    }
  });
});

describe("gateway.channelHealthCheckMinutes", () => {
  it("accepts preauth handshake timeout tuning", () => {
    const res = validateConfigObject({
      gateway: {
        handshakeTimeoutMs: 30_000,
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-positive preauth handshake timeouts", () => {
    const res = validateConfigObject({
      gateway: {
        handshakeTimeoutMs: 0,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.handshakeTimeoutMs");
    }
  });

  it("accepts zero to disable monitor", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 0,
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects negative intervals", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: -1,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.channelHealthCheckMinutes");
    }
  });

  it("rejects stale thresholds shorter than the health check interval", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 5,
        channelStaleEventThresholdMinutes: 4,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.channelStaleEventThresholdMinutes");
    }
  });

  it("accepts stale thresholds that match or exceed the health check interval", () => {
    const equal = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 5,
        channelStaleEventThresholdMinutes: 5,
      },
    });
    expect(equal.ok).toBe(true);

    const greater = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 5,
        channelStaleEventThresholdMinutes: 6,
      },
    });
    expect(greater.ok).toBe(true);
  });

  it("rejects stale thresholds shorter than the default health check interval", () => {
    const res = validateConfigObject({
      gateway: {
        channelStaleEventThresholdMinutes: 4,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.channelStaleEventThresholdMinutes");
    }
  });
});

describe("config identity/materialization regressions", () => {
  it("keeps explicit responsePrefix and group mention patterns", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Samantha Sloth",
              theme: "space lobster",
              emoji: "🦞",
            },
            groupChat: { mentionPatterns: ["@openclaw"] },
          },
        ],
      },
      messages: {
        responsePrefix: "✅",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.messages?.responsePrefix).toBe("✅");
      expect(res.config.agents?.list?.[0]?.groupChat?.mentionPatterns).toEqual(["@openclaw"]);
    }
  });

  it("preserves empty responsePrefix when identity is present", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Samantha",
              theme: "helpful sloth",
              emoji: "🦥",
            },
          },
        ],
      },
      messages: {
        responsePrefix: "",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.messages?.responsePrefix).toBe("");
    }
  });

  it("accepts blank model provider apiKey values", () => {
    const res = validateConfigObjectRaw({
      models: {
        mode: "merge",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            apiKey: "",
            api: "anthropic-messages",
            models: [
              {
                id: "MiniMax-M2.7",
                name: "MiniMax M2.7",
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.models?.providers?.minimax?.baseUrl).toBe(
        "https://api.minimax.io/anthropic",
      );
      expect(res.config.models?.providers?.minimax?.apiKey).toBe("");
    }
  });
});

describe("cron webhook schema", () => {
  it("accepts cron.webhookToken and legacy cron.webhook", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        enabled: true,
        webhook: "https://example.invalid/legacy-cron-webhook",
        webhookToken: "secret-token",
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts cron.webhookToken SecretRef values", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        webhook: "https://example.invalid/legacy-cron-webhook",
        webhookToken: {
          source: "env",
          provider: "default",
          id: "CRON_WEBHOOK_TOKEN",
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects non-http cron.webhook URLs", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        webhook: "ftp://example.invalid/legacy-cron-webhook",
      },
    });

    expect(res.success).toBe(false);
  });

  it("accepts cron.retry config", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        retry: {
          maxAttempts: 5,
          backoffMs: [60000, 120000, 300000],
          retryOn: ["rate_limit", "overloaded", "network"],
        },
      },
    });
    expect(res.success).toBe(true);
  });
});

describe("broadcast", () => {
  it("accepts a broadcast peer map with strategy", () => {
    const res = validateConfigObject({
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "parallel",
        "120363403215116621@g.us": ["alfred", "baerbel"],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects invalid broadcast strategy", () => {
    const res = validateConfigObject({
      broadcast: { strategy: "nope" },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects non-array broadcast entries", () => {
    const res = validateConfigObject({
      broadcast: { "120363403215116621@g.us": 123 },
    });
    expect(res.ok).toBe(false);
  });
});

describe("model compat config schema", () => {
  it.each(["zai", "qwen", "qwen-chat-template"] as const)(
    "accepts full openai-completions compat fields with %s thinking format",
    (thinkingFormat) => {
      const res = OpenClawSchema.safeParse({
        models: {
          providers: {
            local: {
              baseUrl: "http://127.0.0.1:1234/v1",
              api: "openai-completions",
              models: [
                {
                  id: "qwen3-32b",
                  name: "Qwen3 32B",
                  compat: {
                    supportsUsageInStreaming: true,
                    supportsStrictMode: false,
                    requiresStringContent: true,
                    thinkingFormat,
                    requiresToolResultName: true,
                    requiresAssistantAfterToolResult: false,
                    requiresThinkingAsText: false,
                    requiresMistralToolIds: false,
                    requiresOpenAiAnthropicToolPayload: true,
                  },
                },
              ],
            },
          },
        },
      });

      expect(res.success).toBe(true);
    },
  );
});

describe("config paths", () => {
  it("rejects empty and blocked paths", () => {
    expect(parseConfigPath("")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
    expect(parseConfigPath("__proto__.polluted").ok).toBe(false);
    expect(parseConfigPath("constructor.polluted").ok).toBe(false);
    expect(parseConfigPath("prototype.polluted").ok).toBe(false);
  });

  it("sets, gets, and unsets nested values", () => {
    const root: Record<string, unknown> = {};
    const parsed = parseConfigPath("foo.bar");
    if (!parsed.ok || !parsed.path) {
      throw new Error("path parse failed");
    }
    setConfigValueAtPath(root, parsed.path, 123);
    expect(getConfigValueAtPath(root, parsed.path)).toBe(123);
    expect(unsetConfigValueAtPath(root, parsed.path)).toBe(true);
    expect(getConfigValueAtPath(root, parsed.path)).toBeUndefined();
  });
});

describe("config strict validation", () => {
  it("rejects unknown fields", () => {
    const res = validateConfigObject({
      agents: { list: [{ id: "pi" }] },
      customUnknownField: { nested: "value" },
    });
    expect(res.ok).toBe(false);
  });

  it("accepts documented agents.list[].params overrides", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            model: "anthropic/claude-opus-4-6",
            params: {
              cacheRetention: "none",
              temperature: 0.4,
              maxTokens: 8192,
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.list?.[0]?.params).toEqual({
        cacheRetention: "none",
        temperature: 0.4,
        maxTokens: 8192,
      });
    }
  });

  it("rejects top-level memorySearch without read-time auto-migration", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        memorySearch: {
          provider: "local",
          fallback: "none",
          query: { maxResults: 7 },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expectSomeIssueMessageContains(snap.issues, '"memorySearch"');
      expect(issuePaths(snap.legacyIssues)).toContain("memorySearch");
      expect((snap.sourceConfig as { memorySearch?: unknown }).memorySearch).toEqual({
        provider: "local",
        fallback: "none",
        query: { maxResults: 7 },
      });
      expect(snap.sourceConfig.agents?.defaults?.memorySearch).toBeUndefined();
    });
  });

  it("rejects top-level heartbeat agent settings without read-time auto-migration", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        heartbeat: {
          every: "30m",
          model: "anthropic/claude-3-5-haiku-20241022",
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expectSomeIssueMessageContains(snap.issues, '"heartbeat"');
      expect(issuePaths(snap.legacyIssues)).toContain("heartbeat");
      expect((snap.sourceConfig as { heartbeat?: unknown }).heartbeat).toEqual({
        every: "30m",
        model: "anthropic/claude-3-5-haiku-20241022",
      });
      expect(snap.sourceConfig.agents?.defaults?.heartbeat).toBeUndefined();
    });
  });

  it("rejects top-level heartbeat visibility without read-time auto-migration", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        heartbeat: {
          showOk: true,
          showAlerts: false,
          useIndicator: true,
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expectSomeIssueMessageContains(snap.issues, '"heartbeat"');
      expect(issuePaths(snap.legacyIssues)).toContain("heartbeat");
      expect((snap.sourceConfig as { heartbeat?: unknown }).heartbeat).toEqual({
        showOk: true,
        showAlerts: false,
        useIndicator: true,
      });
      expect(snap.sourceConfig.channels?.defaults?.heartbeat).toBeUndefined();
    });
  });

  it("reports legacy messages.tts provider keys without read-time auto-migration", () => {
    const raw = {
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            apiKey: "test-key",
            voiceId: "voice-1",
          },
        },
      },
    };
    const issues = findLegacyConfigIssues(raw);

    expect(issuePaths(issues)).toContain("messages.tts");
    expect(raw.messages.tts.elevenlabs).toEqual({
      apiKey: "test-key",
      voiceId: "voice-1",
    });
    expect(raw.messages.tts).not.toHaveProperty("providers");
  });

  it("rejects legacy sandbox perSession without read-time auto-migration", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        agents: {
          defaults: {
            sandbox: {
              perSession: true,
            },
          },
          list: [
            {
              id: "pi",
              sandbox: {
                perSession: false,
              },
            },
          ],
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(issuePaths(snap.issues)).toContain("agents.defaults.sandbox");
      expect(issuePaths(snap.issues)).toContain("agents.list.0.sandbox");
      expect(issuePaths(snap.legacyIssues)).toContain("agents.defaults.sandbox");
      expect(issuePaths(snap.legacyIssues)).toContain("agents.list");
      expect(snap.sourceConfig.agents?.defaults?.sandbox).toEqual({ perSession: true });
      expect(snap.sourceConfig.agents?.list?.[0]?.sandbox).toEqual({ perSession: false });
    });
  });

  it("rejects resolved-only gateway.bind aliases as invalid schema values, not legacy", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { bind: "${OPENCLAW_BIND}" },
      });

      const prev = process.env.OPENCLAW_BIND;
      process.env.OPENCLAW_BIND = "0.0.0.0";
      try {
        const snap = await readConfigFileSnapshot();
        expect(snap.valid).toBe(false);
        expect(snap.legacyIssues).toHaveLength(0);
        expect(issuePaths(snap.issues)).toContain("gateway.bind");
      } finally {
        if (prev === undefined) {
          delete process.env.OPENCLAW_BIND;
        } else {
          process.env.OPENCLAW_BIND = prev;
        }
      }
    });
  });

  it("rejects literal gateway.bind host aliases as legacy", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { bind: "0.0.0.0" },
      });

      const snap = await readConfigFileSnapshot();
      expect(snap.valid).toBe(false);
      expect(issuePaths(snap.issues)).toContain("gateway.bind");
      expect(issuePaths(snap.legacyIssues)).toContain("gateway.bind");
    });
  });
});
