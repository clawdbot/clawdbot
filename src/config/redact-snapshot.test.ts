import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import {
  makeSnapshot,
  restoreRedactedValues,
  type TestSnapshot,
} from "./redact-snapshot.test-helpers.js";
import { buildConfigSchema, type ConfigUiHints } from "./schema.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

function expectNestedLevelPairValue(
  source: Record<string, Record<string, Record<string, unknown>>>,
  field: string,
  expected: readonly [unknown, unknown],
): void {
  const values = source.nested.level[field] as unknown[];
  expect(values[0]).toBe(expected[0]);
  expect(values[1]).toBe(expected[1]);
}

function expectGatewayAuthFieldValue(
  result: ReturnType<typeof redactConfigSnapshot>,
  field: "token" | "password",
  expected: string,
): void {
  const gateway = result.config.gateway as Record<string, Record<string, string>>;
  const resolved = result.resolved as Record<string, Record<string, Record<string, string>>>;
  expect(gateway.auth[field]).toBe(expected);
  expect(resolved.gateway.auth[field]).toBe(expected);
}

describe("redactConfigSnapshot", () => {
  it("does not expose internal plugin metadata snapshot fields", () => {
    const snapshot = {
      ...makeSnapshot({
        plugins: {
          allow: ["demo"],
        },
      }),
      pluginMetadataSnapshot: {
        manifestRegistry: {
          plugins: [
            {
              id: "demo",
              rootDir: "/private/plugin/root",
              manifestPath: "/private/plugin/root/openclaw.plugin.json",
            },
          ],
          diagnostics: [],
        },
      },
    };

    const result = redactConfigSnapshot(snapshot);

    expect("pluginMetadataSnapshot" in result).toBe(false);
  });

  it("redacts common secret field patterns across config sections", () => {
    const snapshot = makeSnapshot({
      gateway: {
        auth: {
          token: "my-super-secret-gateway-token-value",
          password: "super-secret-password-value-here",
        },
      },
      channels: {
        telegram: {
          botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
          webhookSecret: "telegram-webhook-secret-value-1234",
        },
        slack: {
          botToken: "fake-slack-bot-token-placeholder-value",
          signingSecret: "slack-signing-secret-value-1234",
          token: "secret-slack-token-value-here",
        },
        feishu: {
          appSecret: "feishu-app-secret-value-here-1234",
          encryptKey: "feishu-encrypt-key-value-here-1234",
        },
      },
      models: {
        providers: {
          openai: { apiKey: "sk-proj-abcdef1234567890ghij", baseUrl: "https://api.openai.com" },
        },
      },
      shortSecret: { token: "short" },
    });
    const result = redactConfigSnapshot(snapshot);
    const cfg = result.config as typeof snapshot.config;

    expect(cfg.gateway.auth.token).toBe(REDACTED_SENTINEL);
    expect(cfg.gateway.auth.password).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.telegram.botToken).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.telegram.webhookSecret).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.slack.botToken).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.slack.signingSecret).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.slack.token).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.feishu.appSecret).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.feishu.encryptKey).toBe(REDACTED_SENTINEL);
    expect(cfg.models.providers.openai.apiKey).toBe(REDACTED_SENTINEL);
    expect(cfg.models.providers.openai.baseUrl).toBe("https://api.openai.com");
    expect(cfg.shortSecret.token).toBe(REDACTED_SENTINEL);
  });

  it("redacts googlechat serviceAccount object payloads", () => {
    const snapshot = makeSnapshot({
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
            client_email: "bot@example.iam.gserviceaccount.com",
            private_key: "-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----", // pragma: allowlist secret
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, unknown>>;
    expect(channels.googlechat.serviceAccount).toBe(REDACTED_SENTINEL);
  });

  it("redacts object-valued apiKey refs in model providers", () => {
    const snapshot = makeSnapshot({
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: "https://api.openai.com",
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot);
    const models = result.config.models as Record<string, Record<string, Record<string, unknown>>>;
    expect(models.providers.openai.apiKey).toEqual({
      source: REDACTED_SENTINEL,
      provider: REDACTED_SENTINEL,
      id: REDACTED_SENTINEL,
    });
    expect(models.providers.openai.baseUrl).toBe("https://api.openai.com");
  });

  it("preserves non-sensitive fields", () => {
    const snapshot = makeSnapshot({
      ui: { seamColor: "#0088cc" },
      gateway: { port: 18789 },
      models: { providers: { openai: { baseUrl: "https://api.openai.com" } } },
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config).toEqual(snapshot.config);
  });

  it("removes embedded credentials from URL-valued endpoint fields", () => {
    const raw = `{
  models: {
    providers: {
      openai: {
        baseUrl: "https://alice:secret@example.test/v1",
      },
    },
  },
}`;
    const snapshot = makeSnapshot(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://alice:secret@example.test/v1",
            },
          },
        },
      },
      raw,
    );

    const result = redactConfigSnapshot(snapshot);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.models.providers.openai.baseUrl).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("alice:secret@");
  });

  it("redacts and restores MCP SSE header values from schema hints", () => {
    const hints = buildConfigSchema().uiHints;
    const snapshot = makeSnapshot({
      mcp: {
        servers: {
          remote: {
            url: "https://example.com/mcp",
            headers: {
              Authorization: "Bearer secret-token",
              "X-Test": "ok",
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const servers = (result.config.mcp as { servers: Record<string, Record<string, unknown>> })
      .servers;
    expect((servers.remote.headers as Record<string, string>).Authorization).toBe(
      REDACTED_SENTINEL,
    );
    expect((servers.remote.headers as Record<string, string>)["X-Test"]).toBe(REDACTED_SENTINEL);

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.mcp.servers.remote.headers.Authorization).toBe("Bearer secret-token");
    expect(restored.mcp.servers.remote.headers["X-Test"]).toBe("ok");
  });

  it("redacts sensitive auth material from MCP SSE URLs", () => {
    const hints = buildConfigSchema().uiHints;
    const raw = `{
  mcp: {
    servers: {
      remote: {
        url: "https://user:pass@example.com/mcp?token=secret123&safe=value",
      },
    },
  },
}`;
    const snapshot = makeSnapshot(
      {
        mcp: {
          servers: {
            remote: {
              url: "https://user:pass@example.com/mcp?token=secret123&safe=value",
            },
          },
        },
      },
      raw,
    );

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.mcp.servers.remote.url).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("user:pass@");
    expect(result.raw).not.toContain("secret123");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.mcp.servers.remote.url).toBe(
      "https://user:pass@example.com/mcp?token=secret123&safe=value",
    );
  });

  it("redacts media request auth and proxy transport secrets from config snapshots", () => {
    const hints = buildConfigSchema().uiHints;
    const raw = `{
  tools: {
    media: {
      audio: {
        request: {
          auth: {
            mode: "authorization-bearer",
            token: "media-audio-secret-token",
          },
          proxy: {
            mode: "explicit-proxy",
            url: "http://alice:secret@proxy.example.internal:8080",
          },
        },
      },
    },
  },
}`;
    const snapshot = makeSnapshot(
      {
        tools: {
          media: {
            audio: {
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: "media-audio-secret-token",
                },
                proxy: {
                  mode: "explicit-proxy",
                  url: "http://alice:secret@proxy.example.internal:8080",
                },
              },
            },
          },
        },
      },
      raw,
    );

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.tools.media.audio.request.auth.token).toBe(REDACTED_SENTINEL);
    expect(cfg.tools.media.audio.request.proxy.url).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("media-audio-secret-token");
    expect(result.raw).not.toContain("alice:secret@");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.tools.media.audio.request.auth.token).toBe("media-audio-secret-token");
    expect(restored.tools.media.audio.request.proxy.url).toBe(
      "http://alice:secret@proxy.example.internal:8080",
    );
  });

  it("redacts model provider request auth secrets from config snapshots", () => {
    const hints = buildConfigSchema().uiHints;
    const raw = `{
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [],
        request: {
          auth: {
            mode: "authorization-bearer",
            token: "provider-secret-token",
          },
        },
      },
    },
  },
}`;
    const snapshot = makeSnapshot(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [],
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: "provider-secret-token",
                },
              },
            },
          },
        },
      },
      raw,
    );

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.models.providers.openai.request.auth.token).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("provider-secret-token");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.models.providers.openai.request.auth.token).toBe("provider-secret-token");
  });

  it("redacts model provider local service env values from config snapshots", () => {
    const hints = buildConfigSchema().uiHints;
    const raw = `{
  models: {
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:18000/v1",
        models: [],
        localService: {
          command: "/usr/local/bin/server",
          env: {
            HF_HOME: "local-service-secret-home",
            MAX_TOKENS: "local-service-secret-limit",
          },
        },
      },
    },
  },
}`;
    const snapshot = makeSnapshot(
      {
        models: {
          providers: {
            local: {
              baseUrl: "http://127.0.0.1:18000/v1",
              models: [],
              localService: {
                command: "/usr/local/bin/server",
                env: {
                  HF_HOME: "local-service-secret-home",
                  MAX_TOKENS: "local-service-secret-limit",
                },
              },
            },
          },
        },
      },
      raw,
    );

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.models.providers.local.localService.env.HF_HOME).toBe(REDACTED_SENTINEL);
    expect(cfg.models.providers.local.localService.env.MAX_TOKENS).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("local-service-secret-home");
    expect(result.raw).not.toContain("local-service-secret-limit");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.models.providers.local.localService.env.HF_HOME).toBe(
      "local-service-secret-home",
    );
  });

  it("redacts model provider request proxy URLs from config snapshots", () => {
    const hints = buildConfigSchema().uiHints;
    const raw = `{
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [],
        request: {
          proxy: {
            mode: "explicit-proxy",
            url: "http://alice:secret@proxy.example.internal:8080",
          },
        },
      },
    },
  },
}`;
    const snapshot = makeSnapshot(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [],
              request: {
                proxy: {
                  mode: "explicit-proxy",
                  url: "http://alice:secret@proxy.example.internal:8080",
                },
              },
            },
          },
        },
      },
      raw,
    );

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.models.providers.openai.request.proxy.url).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("alice:secret@");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.models.providers.openai.request.proxy.url).toBe(
      "http://alice:secret@proxy.example.internal:8080",
    );
  });

  it("does not redact maxTokens-style fields", () => {
    const snapshot = makeSnapshot({
      maxTokens: 16384,
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                maxTokens: 65536,
                contextTokens: 200000,
                maxTokensField: "max_completion_tokens",
              },
            ],
            apiKey: "sk-proj-abcdef1234567890ghij",
            accessToken: "access-token-value-1234567890",
            maxTokens: 8192,
            maxOutputTokens: 4096,
            maxCompletionTokens: 2048,
            contextTokens: 128000,
            tokenCount: 500,
            tokenLimit: 100000,
            tokenBudget: 50000,
          },
        },
      },
      gateway: { auth: { token: "secret-gateway-token-value" } },
    });

    const result = redactConfigSnapshot(snapshot);
    expect((result.config as Record<string, unknown>).maxTokens).toBe(16384);
    const models = result.config.models as Record<string, unknown>;
    const providerList = ((
      (models.providers as Record<string, unknown>).openai as Record<string, unknown>
    ).models ?? []) as Array<Record<string, unknown>>;
    expect(providerList[0]?.maxTokens).toBe(65536);
    expect(providerList[0]?.contextTokens).toBe(200000);
    expect(providerList[0]?.maxTokensField).toBe("max_completion_tokens");

    const providers = (models.providers as Record<string, Record<string, unknown>>) ?? {};
    expect(providers.openai.apiKey).toBe(REDACTED_SENTINEL);
    expect(providers.openai.accessToken).toBe(REDACTED_SENTINEL);
    expect(providers.openai.maxTokens).toBe(8192);
    expect(providers.openai.maxOutputTokens).toBe(4096);
    expect(providers.openai.maxCompletionTokens).toBe(2048);
    expect(providers.openai.contextTokens).toBe(128000);
    expect(providers.openai.tokenCount).toBe(500);
    expect(providers.openai.tokenLimit).toBe(100000);
    expect(providers.openai.tokenBudget).toBe(50000);

    const gw = result.config.gateway as Record<string, Record<string, string>>;
    expect(gw.auth.token).toBe(REDACTED_SENTINEL);
  });

  it("does not redact passwordFile path fields", () => {
    const snapshot = makeSnapshot({
      channels: {
        irc: {
          passwordFile: "/etc/openclaw/irc-password.txt",
          nickserv: {
            passwordFile: "/etc/openclaw/nickserv-password.txt",
            password: "super-secret-nickserv-password",
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, unknown>>;
    const irc = channels.irc;
    const nickserv = irc.nickserv as Record<string, unknown>;

    expect(irc.passwordFile).toBe("/etc/openclaw/irc-password.txt");
    expect(nickserv.passwordFile).toBe("/etc/openclaw/nickserv-password.txt");
    expect(nickserv.password).toBe(REDACTED_SENTINEL);
  });

  it("preserves hash unchanged", () => {
    const snapshot = makeSnapshot({ gateway: { auth: { token: "secret-token-value-here" } } });
    const result = redactConfigSnapshot(snapshot);
    expect(result.hash).toBe("abc123");
  });

  it("redacts secrets in raw field via text-based redaction", () => {
    const config = { token: "abcdef1234567890ghij" };
    const raw = '{ "token": "abcdef1234567890ghij" }';
    const snapshot = makeSnapshot(config, raw);
    const result = redactConfigSnapshot(snapshot);
    expect(result.raw).not.toContain("abcdef1234567890ghij");
    expect(result.raw).toContain(REDACTED_SENTINEL);
  });

  it("drops raw text when overlap fallback triggers", () => {
    const config = {
      gateway: {
        mode: "local",
        auth: { password: "local" }, // pragma: allowlist secret
      },
    };
    const snapshot = makeSnapshot(config, JSON.stringify(config));
    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    expect(result.raw).toBeNull();
    const cfg = result.config as {
      gateway?: { mode?: string; auth?: { password?: string } };
    };
    expect(cfg.gateway?.mode).toBe("local");
    expect(cfg.gateway?.auth?.password).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, mainSchemaHints);
    expect(restored.gateway.mode).toBe("local");
    expect(restored.gateway.auth.password).toBe("local");
  });

  it("preserves SecretRef structural fields while redacting SecretRef id", () => {
    const config = {
      models: {
        providers: {
          default: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: "https://api.openai.com",
          },
        },
      },
    };
    const snapshot = makeSnapshot(config, JSON.stringify(config, null, 2));
    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    expect(result.raw).not.toContain("OPENAI_API_KEY");
    const parsed: {
      models?: { providers?: { default?: { apiKey?: { source?: string; provider?: string } } } };
    } = JSON5.parse(result.raw ?? "{}");
    expect(parsed.models?.providers?.default?.apiKey?.source).toBe("env");
    expect(parsed.models?.providers?.default?.apiKey?.provider).toBe("default");
    const restored = restoreRedactedValues(parsed, snapshot.config, mainSchemaHints);
    expect(restored).toEqual(snapshot.config);
  });

  it("handles overlap fallback and SecretRef in the same snapshot", () => {
    const config = {
      gateway: { mode: "default", auth: { password: "default" } }, // pragma: allowlist secret
      models: {
        providers: {
          default: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: "https://api.openai.com",
          },
        },
      },
    };
    const snapshot = makeSnapshot(config, JSON.stringify(config, null, 2));
    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    expect(result.raw).toBeNull();
    const cfg = result.config as {
      gateway?: { mode?: string; auth?: { password?: string } };
      models?: {
        providers?: { default?: { apiKey?: { source?: string; provider?: string; id?: string } } };
      };
    };
    expect(cfg.gateway?.mode).toBe("default");
    expect(cfg.gateway?.auth?.password).toBe(REDACTED_SENTINEL);
    expect(cfg.models?.providers?.default?.apiKey?.source).toBe("env");
    expect(cfg.models?.providers?.default?.apiKey?.provider).toBe("default");
    expect(cfg.models?.providers?.default?.apiKey?.id).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, mainSchemaHints);
    expect(restored).toEqual(snapshot.config);
  });

  it("does not mangle raw when a sensitive field value is empty string", () => {
    const config = {
      gateway: { auth: { token: "" } },
      other: "",
    };
    const raw = '{ "gateway": { "auth": { "token": "" } }, "other": "" }';
    const snapshot = makeSnapshot(config, raw);
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.gateway?.auth?.token).toBe(REDACTED_SENTINEL);
    expect(result.raw).toBe(raw);
    expect((result.raw ?? "").split(REDACTED_SENTINEL).length).toBe(1);
  });

  it("redacts parsed and resolved objects", () => {
    const snapshot = makeSnapshot({
      channels: { discord: { token: "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.FgH" } },
      gateway: { auth: { token: "supersecrettoken123456" } },
    });
    const result = redactConfigSnapshot(snapshot);
    const parsed = result.parsed as Record<string, Record<string, Record<string, string>>>;
    const sourceConfig = result.sourceConfig as Record<
      string,
      Record<string, Record<string, string>>
    >;
    const resolved = result.resolved as Record<string, Record<string, Record<string, string>>>;
    const runtimeConfig = result.runtimeConfig as Record<
      string,
      Record<string, Record<string, string>>
    >;
    expect(parsed.channels.discord.token).toBe(REDACTED_SENTINEL);
    expect(sourceConfig.gateway.auth.token).toBe(REDACTED_SENTINEL);
    expect(resolved.gateway.auth.token).toBe(REDACTED_SENTINEL);
    expect(runtimeConfig.channels.discord.token).toBe(REDACTED_SENTINEL);
    expect(result.sourceConfig).toBe(result.resolved);
    expect(result.runtimeConfig).toBe(result.config);
  });

  it("handles null raw gracefully", () => {
    const snapshot: ConfigFileSnapshot = {
      path: "/test",
      exists: false,
      raw: null,
      parsed: null,
      sourceConfig: {} as ConfigFileSnapshot["sourceConfig"],
      resolved: {} as ConfigFileSnapshot["resolved"],
      valid: false,
      runtimeConfig: {} as ConfigFileSnapshot["runtimeConfig"],
      config: {} as ConfigFileSnapshot["config"],
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
    const result = redactConfigSnapshot(snapshot);
    expect(result.raw).toBeNull();
    expect(result.parsed).toBeNull();
  });

  it("withholds resolved config for invalid snapshots", () => {
    const snapshot: ConfigFileSnapshot = {
      path: "/test",
      exists: true,
      raw: '{ "gateway": { "auth": { "token": "leaky-secret" } } }',
      parsed: { gateway: { auth: { token: "leaky-secret" } } },
      sourceConfig: {
        gateway: { auth: { token: "leaky-secret" } },
      } as ConfigFileSnapshot["sourceConfig"],
      resolved: { gateway: { auth: { token: "leaky-secret" } } } as ConfigFileSnapshot["resolved"],
      valid: false,
      runtimeConfig: {} as ConfigFileSnapshot["runtimeConfig"],
      config: {} as ConfigFileSnapshot["config"],
      issues: [{ path: "", message: "invalid config" }],
      warnings: [],
      legacyIssues: [],
    };
    const result = redactConfigSnapshot(snapshot);
    expect(result.raw).toBeNull();
    expect(result.parsed).toBeNull();
    expect(result.sourceConfig).toStrictEqual({});
    expect(result.resolved).toStrictEqual({});
    expect(result.runtimeConfig).toStrictEqual({});
    expect(result.sourceConfig).toBe(result.resolved);
    expect(result.runtimeConfig).toBe(result.config);
  });

  it("handles deeply nested tokens in accounts", () => {
    const snapshot = makeSnapshot({
      channels: {
        slack: {
          accounts: {
            workspace1: { botToken: "fake-workspace1-token-abcdefghij" },
            workspace2: { appToken: "fake-workspace2-token-abcdefghij" },
          },
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<
      string,
      Record<string, Record<string, Record<string, string>>>
    >;
    expect(channels.slack.accounts.workspace1.botToken).toBe(REDACTED_SENTINEL);
    expect(channels.slack.accounts.workspace2.appToken).toBe(REDACTED_SENTINEL);
  });

  it("redacts env vars that look like secrets", () => {
    const snapshot = makeSnapshot({
      env: {
        vars: {
          OPENAI_API_KEY: "sk-proj-1234567890abcdefghij",
          NODE_ENV: "production",
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const env = result.config.env as Record<string, Record<string, string>>;
    // NODE_ENV is not sensitive, should be preserved
    expect(env.vars.NODE_ENV).toBe("production");
    expect(env.vars.OPENAI_API_KEY).toBe(REDACTED_SENTINEL);
  });

  it.each([
    {
      name: "does not redact numeric tokens field",
      snapshot: makeSnapshot({ memory: { tokens: 8192 } }),
      assert: (config: Record<string, unknown>) => {
        expect((config.memory as Record<string, unknown>).tokens).toBe(8192);
      },
    },
    {
      name: "does not redact softThresholdTokens",
      snapshot: makeSnapshot({ compaction: { softThresholdTokens: 50000 } }),
      assert: (config: Record<string, unknown>) => {
        expect((config.compaction as Record<string, unknown>).softThresholdTokens).toBe(50000);
      },
    },
    {
      name: "does not redact string tokens field",
      snapshot: makeSnapshot({ memory: { tokens: "should-not-be-redacted" } }),
      assert: (config: Record<string, unknown>) => {
        expect((config.memory as Record<string, unknown>).tokens).toBe("should-not-be-redacted");
      },
    },
    {
      name: "still redacts singular token field",
      snapshot: makeSnapshot({
        channels: { slack: { token: "secret-slack-token-value-here" } },
      }),
      assert: (config: Record<string, unknown>) => {
        const channels = config.channels as Record<string, Record<string, string>>;
        expect(channels.slack.token).toBe(REDACTED_SENTINEL);
      },
    },
  ] as const)("respects token-name redaction boundaries: $name", ({ snapshot, assert }) => {
    const result = redactConfigSnapshot(snapshot);
    assert(result.config as Record<string, unknown>);
  });

  it("uses uiHints to determine sensitivity", () => {
    const hints: ConfigUiHints = {
      "custom.mySecret": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      custom: { mySecret: "this-is-a-custom-secret-value" },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    const config = result.config as typeof snapshot.config;
    const custom = config.custom as Record<string, string>;
    const resolved = result.resolved as Record<string, Record<string, string>>;
    expect(custom.mySecret).toBe(REDACTED_SENTINEL);
    expect(resolved.custom.mySecret).toBe(REDACTED_SENTINEL);
  });

  it("keeps regex fallback for extension keys not covered by uiHints", () => {
    const hints: ConfigUiHints = {
      "plugins.entries.voice-call.config": { label: "Voice Call Config" },
      "channels.my-channel": { label: "My Channel" },
    };
    const snapshot = makeSnapshot({
      plugins: {
        entries: {
          "voice-call": {
            config: {
              apiToken: "voice-call-secret-token",
              displayName: "Voice call extension",
            },
          },
        },
      },
      channels: {
        "my-channel": {
          accessToken: "my-channel-secret-token",
          room: "general",
        },
      },
    });

    const redacted = redactConfigSnapshot(snapshot, hints);
    const config = redacted.config as typeof snapshot.config;
    expect(config.plugins.entries["voice-call"].config.apiToken).toBe(REDACTED_SENTINEL);
    expect(config.plugins.entries["voice-call"].config.displayName).toBe("Voice call extension");
    expect(config.channels["my-channel"].accessToken).toBe(REDACTED_SENTINEL);
    expect(config.channels["my-channel"].room).toBe("general");

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored).toEqual(snapshot.config);
  });

  it("honors sensitive:false for extension keys even with regex fallback", () => {
    const hints: ConfigUiHints = {
      "plugins.entries.voice-call.config": { label: "Voice Call Config" },
      "plugins.entries.voice-call.config.apiToken": { sensitive: false },
    };
    const snapshot = makeSnapshot({
      plugins: {
        entries: {
          "voice-call": {
            config: {
              apiToken: "not-secret-on-purpose",
            },
          },
        },
      },
    });

    const redacted = redactConfigSnapshot(snapshot, hints);
    const config = redacted.config as typeof snapshot.config;
    expect(config.plugins.entries["voice-call"].config.apiToken).toBe("not-secret-on-purpose");
  });

  it("round-trips nested and array sensitivity cases", () => {
    const customSecretValue = "this-is-a-custom-secret-value";
    const buildNestedValuesSnapshot = () =>
      makeSnapshot({
        custom1: { anykey: { mySecret: customSecretValue } },
        custom2: [{ mySecret: customSecretValue }],
      });
    const assertNestedValuesRoundTrip = ({
      redacted,
      restored,
    }: {
      redacted: Record<string, unknown>;
      restored: Record<string, unknown>;
    }) => {
      const cfg = redacted as Record<string, Record<string, unknown>>;
      const cfgCustom2 = cfg.custom2 as unknown as unknown[];
      expect(cfgCustom2.length).toBeGreaterThan(0);
      expect((cfg.custom1.anykey as Record<string, unknown>).mySecret).toBe(REDACTED_SENTINEL);
      expect((cfgCustom2[0] as Record<string, unknown>).mySecret).toBe(REDACTED_SENTINEL);

      const out = restored as Record<string, Record<string, unknown>>;
      const outCustom2 = out.custom2 as unknown as unknown[];
      expect(outCustom2.length).toBeGreaterThan(0);
      expect((out.custom1.anykey as Record<string, unknown>).mySecret).toBe(customSecretValue);
      expect((outCustom2[0] as Record<string, unknown>).mySecret).toBe(customSecretValue);
    };

    const cases: Array<{
      name: string;
      snapshot: TestSnapshot<Record<string, unknown>>;
      hints?: ConfigUiHints;
      assert: (params: {
        redacted: Record<string, unknown>;
        restored: Record<string, unknown>;
      }) => void;
    }> = [
      {
        name: "nested values (schema)",
        snapshot: buildNestedValuesSnapshot(),
        assert: assertNestedValuesRoundTrip,
      },
      {
        name: "nested values (uiHints)",
        hints: {
          "custom1.*.mySecret": { sensitive: true },
          "custom2[].mySecret": { sensitive: true },
        },
        snapshot: buildNestedValuesSnapshot(),
        assert: assertNestedValuesRoundTrip,
      },
      {
        name: "directly sensitive records and arrays",
        snapshot: makeSnapshot({
          custom: {
            token: "this-is-a-custom-secret-value",
            mySecret: "this-is-a-custom-secret-value",
          },
          token: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted;
          const custom = cfg.custom as Record<string, unknown>;
          expect(custom.token).toBe(REDACTED_SENTINEL);
          expect(custom.mySecret).toBe(REDACTED_SENTINEL);
          expect((cfg.token as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.token as unknown[])[1]).toBe(REDACTED_SENTINEL);

          const out = restored;
          const restoredCustom = out.custom as Record<string, unknown>;
          expect(restoredCustom.token).toBe("this-is-a-custom-secret-value");
          expect(restoredCustom.mySecret).toBe("this-is-a-custom-secret-value");
          expect((out.token as unknown[])[0]).toBe("this-is-a-custom-secret-value");
          expect((out.token as unknown[])[1]).toBe("this-is-a-custom-secret-value");
        },
      },
      {
        name: "directly sensitive records and arrays (uiHints)",
        hints: {
          "custom.*": { sensitive: true },
          "customArray[]": { sensitive: true },
        },
        snapshot: makeSnapshot({
          custom: {
            anykey: "this-is-a-custom-secret-value",
            mySecret: "this-is-a-custom-secret-value",
          },
          customArray: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted;
          const custom = cfg.custom as Record<string, unknown>;
          expect(custom.anykey).toBe(REDACTED_SENTINEL);
          expect(custom.mySecret).toBe(REDACTED_SENTINEL);
          expect((cfg.customArray as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.customArray as unknown[])[1]).toBe(REDACTED_SENTINEL);

          const out = restored;
          const restoredCustom = out.custom as Record<string, unknown>;
          expect(restoredCustom.anykey).toBe("this-is-a-custom-secret-value");
          expect(restoredCustom.mySecret).toBe("this-is-a-custom-secret-value");
          expect((out.customArray as unknown[])[0]).toBe("this-is-a-custom-secret-value");
          expect((out.customArray as unknown[])[1]).toBe("this-is-a-custom-secret-value");
        },
      },
      {
        name: "non-sensitive arrays remain unchanged",
        hints: {
          "custom[]": { sensitive: false },
        },
        snapshot: makeSnapshot({
          harmless: ["this-is-a-custom-harmless-value", "this-is-a-custom-secret-looking-value"],
          custom: ["this-is-a-custom-harmless-value", "this-is-a-custom-secret-value"],
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted;
          expect((cfg.harmless as unknown[])[0]).toBe("this-is-a-custom-harmless-value");
          expect((cfg.harmless as unknown[])[1]).toBe("this-is-a-custom-secret-looking-value");
          expect((cfg.custom as unknown[])[0]).toBe("this-is-a-custom-harmless-value");
          expect((cfg.custom as unknown[])[1]).toBe("this-is-a-custom-secret-value");

          const out = restored;
          expect((out.harmless as unknown[])[0]).toBe("this-is-a-custom-harmless-value");
          expect((out.harmless as unknown[])[1]).toBe("this-is-a-custom-secret-looking-value");
          expect((out.custom as unknown[])[0]).toBe("this-is-a-custom-harmless-value");
          expect((out.custom as unknown[])[1]).toBe("this-is-a-custom-secret-value");
        },
      },
      {
        name: "deep schema-sensitive arrays and upstream-sensitive paths",
        snapshot: makeSnapshot({
          nested: {
            level: {
              token: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
              harmless: ["value", "value"],
            },
            password: {
              harmless: ["value", "value"],
            },
          },
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted as Record<string, Record<string, Record<string, unknown>>>;
          expect((cfg.nested.level.token as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.nested.level.token as unknown[])[1]).toBe(REDACTED_SENTINEL);
          expect((cfg.nested.level.harmless as unknown[])[0]).toBe("value");
          expect((cfg.nested.level.harmless as unknown[])[1]).toBe("value");
          expect((cfg.nested.password.harmless as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.nested.password.harmless as unknown[])[1]).toBe(REDACTED_SENTINEL);

          const out = restored as Record<string, Record<string, Record<string, unknown>>>;
          expect((out.nested.level.token as unknown[])[0]).toBe("this-is-a-custom-secret-value");
          expect((out.nested.level.token as unknown[])[1]).toBe("this-is-a-custom-secret-value");
          expect((out.nested.level.harmless as unknown[])[0]).toBe("value");
          expect((out.nested.level.harmless as unknown[])[1]).toBe("value");
          expect((out.nested.password.harmless as unknown[])[0]).toBe("value");
          expect((out.nested.password.harmless as unknown[])[1]).toBe("value");
        },
      },
      {
        name: "deep non-string arrays on schema-sensitive paths remain unchanged",
        snapshot: makeSnapshot({
          nested: {
            level: {
              token: [42, 815],
            },
          },
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted as Record<string, Record<string, Record<string, unknown>>>;
          expectNestedLevelPairValue(cfg, "token", [42, 815]);

          const out = restored as Record<string, Record<string, Record<string, unknown>>>;
          expectNestedLevelPairValue(out, "token", [42, 815]);
        },
      },
      {
        name: "deep arrays respect uiHints sensitivity",
        hints: {
          "nested.level.custom[]": { sensitive: true },
        },
        snapshot: makeSnapshot({
          nested: {
            level: {
              custom: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
            },
          },
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted as Record<string, Record<string, Record<string, unknown>>>;
          expect((cfg.nested.level.custom as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.nested.level.custom as unknown[])[1]).toBe(REDACTED_SENTINEL);

          const out = restored as Record<string, Record<string, Record<string, unknown>>>;
          expect((out.nested.level.custom as unknown[])[0]).toBe("this-is-a-custom-secret-value");
          expect((out.nested.level.custom as unknown[])[1]).toBe("this-is-a-custom-secret-value");
        },
      },
      {
        name: "deep non-string arrays respect uiHints sensitivity",
        hints: {
          "nested.level.custom[]": { sensitive: true },
        },
        snapshot: makeSnapshot({
          nested: {
            level: {
              custom: [42, 815],
            },
          },
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted as Record<string, Record<string, Record<string, unknown>>>;
          expectNestedLevelPairValue(cfg, "custom", [42, 815]);

          const out = restored as Record<string, Record<string, Record<string, unknown>>>;
          expectNestedLevelPairValue(out, "custom", [42, 815]);
        },
      },
    ];

    for (const { snapshot, hints, assert } of cases) {
      const redacted = redactConfigSnapshot(snapshot, hints);
      const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
      assert({
        redacted: redacted.config as Record<string, unknown>,
        restored: restored as Record<string, unknown>,
      });
    }
  });

  it("respects sensitive:false in uiHints even for regex-matching paths", () => {
    const hints: ConfigUiHints = {
      "gateway.auth.token": { sensitive: false },
    };
    const snapshot = makeSnapshot({
      gateway: { auth: { token: "not-actually-secret-value" } },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expectGatewayAuthFieldValue(result, "token", "not-actually-secret-value");
  });

  it("redacts sensitive-looking paths even when absent from uiHints (defense in depth)", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      gateway: { auth: { password: "not-in-hints-value" } },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expectGatewayAuthFieldValue(result, "password", REDACTED_SENTINEL);
  });

  it("redacts privateKey paths even when absent from uiHints (defense in depth)", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      channels: {
        nostr: {
          privateKey: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
          relays: ["wss://relay.example.com"],
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const channels = result.config.channels as Record<string, Record<string, unknown>>;
    expect(channels.nostr.privateKey).toBe(REDACTED_SENTINEL);
    expect(channels.nostr.relays).toEqual(["wss://relay.example.com"]);

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.channels.nostr.privateKey).toBe(
      "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
    );
  });

  it("redacts and restores dynamic env catchall secrets when uiHints miss the path", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      env: {
        GROQ_API_KEY: "gsk-secret-123", // pragma: allowlist secret
        NODE_ENV: "production",
      },
    });
    const redacted = redactConfigSnapshot(snapshot, hints);
    const env = redacted.config.env as Record<string, string>;
    expect(env.GROQ_API_KEY).toBe(REDACTED_SENTINEL);
    expect(env.NODE_ENV).toBe("production");

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored.env.GROQ_API_KEY).toBe("gsk-secret-123");
    expect(restored.env.NODE_ENV).toBe("production");
  });

  it("redacts and restores skills entry env secrets in dynamic record paths", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      skills: {
        entries: {
          web_search: {
            env: {
              GEMINI_API_KEY: "gemini-secret-456", // pragma: allowlist secret
              BRAVE_REGION: "us",
            },
          },
        },
      },
    });
    const redacted = redactConfigSnapshot(snapshot, hints);
    const entry = (
      redacted.config.skills as {
        entries: Record<string, { env: Record<string, string> }>;
      }
    ).entries.web_search;
    expect(entry.env.GEMINI_API_KEY).toBe(REDACTED_SENTINEL);
    expect(entry.env.BRAVE_REGION).toBe("us");

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored.skills.entries.web_search.env.GEMINI_API_KEY).toBe("gemini-secret-456");
    expect(restored.skills.entries.web_search.env.BRAVE_REGION).toBe("us");
  });

  it("contract-covers dynamic catchall/record paths for redact+restore", () => {
    const hints = mainSchemaHints;
    const snapshot = makeSnapshot({
      env: {
        GROQ_API_KEY: "gsk-contract-123", // pragma: allowlist secret
        NODE_ENV: "production",
      },
      skills: {
        entries: {
          web_search: {
            env: {
              GEMINI_API_KEY: "gemini-contract-456", // pragma: allowlist secret
              BRAVE_REGION: "us",
            },
          },
        },
      },
      broadcast: {
        apiToken: ["broadcast-secret-1", "broadcast-secret-2"],
        channels: ["ops", "eng"],
      },
    });

    const redacted = redactConfigSnapshot(snapshot, hints);
    const config = redacted.config as {
      env: Record<string, string>;
      skills: { entries: Record<string, { env: Record<string, string> }> };
      broadcast: Record<string, string[]>;
    };

    expect(config.env.GROQ_API_KEY).toBe(REDACTED_SENTINEL);
    expect(config.env.NODE_ENV).toBe("production");
    expect(config.skills.entries.web_search.env.GEMINI_API_KEY).toBe(REDACTED_SENTINEL);
    expect(config.skills.entries.web_search.env.BRAVE_REGION).toBe("us");
    expect(config.broadcast.apiToken).toEqual([REDACTED_SENTINEL, REDACTED_SENTINEL]);
    expect(config.broadcast.channels).toEqual(["ops", "eng"]);

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored).toEqual(snapshot.config);
  });

  it("uses wildcard hints for array items", () => {
    const hints: ConfigUiHints = {
      "channels.slack.accounts[].botToken": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      channels: {
        slack: {
          accounts: [
            { botToken: "first-account-token-value-here" },
            { botToken: "second-account-token-value-here" },
          ],
        },
      },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    const channels = result.config.channels as Record<
      string,
      Record<string, Array<Record<string, string>>>
    >;
    expect(channels.slack.accounts[0].botToken).toBe(REDACTED_SENTINEL);
    expect(channels.slack.accounts[1].botToken).toBe(REDACTED_SENTINEL);
  });

  it("redacts browser cdpUrl secrets while preserving bare endpoints", () => {
    const hints = buildConfigSchema().uiHints;
    const raw = `{
  browser: {
    cdpUrl: "https://user:pass@chrome.browserless.io?token=supersecret123",
    profiles: {
      remote: {
        cdpUrl: "https://chrome.staging.example.com?token=staging-secret",
      },
      prod: {
        cdpUrl: "https://alice:secret@chrome.prod.example.com",
      },
      local: {
        cdpUrl: "ws://localhost:9222",
      },
    },
  },
}`;
    const snapshot = makeSnapshot(
      {
        browser: {
          cdpUrl: "https://user:pass@chrome.browserless.io?token=supersecret123",
          profiles: {
            remote: {
              cdpUrl: "https://chrome.staging.example.com?token=staging-secret",
            },
            prod: {
              cdpUrl: "https://alice:secret@chrome.prod.example.com",
            },
            local: {
              cdpUrl: "ws://localhost:9222",
            },
          },
        },
      },
      raw,
    );

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.browser.cdpUrl).toBe(REDACTED_SENTINEL);
    expect(cfg.browser.profiles.remote.cdpUrl).toBe(REDACTED_SENTINEL);
    expect(cfg.browser.profiles.prod.cdpUrl).toBe(REDACTED_SENTINEL);
    expect(cfg.browser.profiles.local.cdpUrl).toBe("ws://localhost:9222");
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("user:pass@");
    expect(result.raw).not.toContain("supersecret123");
    expect(result.raw).not.toContain("staging-secret");
    expect(result.raw).not.toContain("alice:secret@");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.browser.cdpUrl).toBe(
      "https://user:pass@chrome.browserless.io?token=supersecret123",
    );
    expect(restored.browser.profiles.remote.cdpUrl).toBe(
      "https://chrome.staging.example.com?token=staging-secret",
    );
    expect(restored.browser.profiles.prod.cdpUrl).toBe(
      "https://alice:secret@chrome.prod.example.com",
    );
    expect(restored.browser.profiles.local.cdpUrl).toBe("ws://localhost:9222");
  });
});
