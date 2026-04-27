import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";

vi.mock("../plugins/setup-registry.js", () => ({
  runPluginSetupConfigMigrations: ({ config }: { config: OpenClawConfig }) => ({
    config,
    changes: [],
  }),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => ({
    plugins: [
      {
        id: "brave",
        origin: "bundled",
        contracts: { webSearchProviders: ["brave"] },
      },
      {
        id: "google",
        origin: "bundled",
        contracts: { webSearchProviders: ["gemini"] },
      },
      {
        id: "firecrawl",
        origin: "bundled",
        contracts: { webSearchProviders: ["firecrawl"] },
      },
    ],
  }),
  resolveManifestContractOwnerPluginId: ({ value }: { value: string }): string | undefined => {
    if (value === "gemini") {
      return "google";
    }
    return value === "brave" || value === "firecrawl" ? value : undefined;
  },
}));

vi.mock("./doctor/shared/channel-legacy-config-migrate.js", () => ({
  applyChannelDoctorCompatibilityMigrations: (cfg: OpenClawConfig) => ({
    next: cfg,
    changes: [],
  }),
}));

vi.mock("../secrets/target-registry.js", () => {
  const entry = {
    id: "channels.discord.token",
    targetType: "channels.discord.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  };

  const readRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  return {
    discoverConfigSecretTargets: (cfg: OpenClawConfig) => {
      const targets: Array<{
        entry: typeof entry;
        path: string;
        pathSegments: string[];
        value: unknown;
        accountId?: string;
      }> = [];
      const channels = readRecord(cfg.channels);
      const discord = readRecord(channels?.discord);
      if (!discord) {
        return targets;
      }
      targets.push({
        entry,
        path: "channels.discord.token",
        pathSegments: ["channels", "discord", "token"],
        value: discord.token,
      });

      const accounts = readRecord(discord.accounts);
      for (const [accountId, accountConfig] of Object.entries(accounts ?? {})) {
        const account = readRecord(accountConfig);
        if (!account) {
          continue;
        }
        targets.push({
          entry,
          path: `channels.discord.accounts.${accountId}.token`,
          pathSegments: ["channels", "discord", "accounts", accountId, "token"],
          value: account.token,
          accountId,
        });
      }
      return targets;
    },
  };
});

describe("normalizeCompatibilityConfigValues", () => {
  let previousOauthDir: string | undefined;
  let tempOauthDir = "";

  const writeCreds = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: {} }));
  };

  const expectNoWhatsAppConfigForLegacyAuth = (setup?: () => void) => {
    setup?.();
    const res = normalizeCompatibilityConfigValues({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });
    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  };

  beforeAll(() => {
    previousOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    tempOauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oauth-"));
    process.env.OPENCLAW_OAUTH_DIR = tempOauthDir;
  });

  beforeEach(() => {
    fs.rmSync(tempOauthDir, { recursive: true, force: true });
    fs.mkdirSync(tempOauthDir, { recursive: true });
  });

  afterAll(() => {
    if (previousOauthDir === undefined) {
      delete process.env.OPENCLAW_OAUTH_DIR;
    } else {
      process.env.OPENCLAW_OAUTH_DIR = previousOauthDir;
    }
    fs.rmSync(tempOauthDir, { recursive: true, force: true });
  });

  it("does not add whatsapp config when missing and no auth exists", () => {
    const res = normalizeCompatibilityConfigValues({
      messages: { ackReaction: "👀" },
    });

    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  });

  it("does not add whatsapp config when only auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsDir = path.join(tempOauthDir ?? "", "whatsapp", "default");
      writeCreds(credsDir);
    });
  });

  it("does not add whatsapp config when only legacy auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsPath = path.join(tempOauthDir ?? "", "creds.json");
      fs.writeFileSync(credsPath, JSON.stringify({ me: {} }));
    });
  });

  it("does not add whatsapp config when only non-default auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsDir = path.join(tempOauthDir ?? "", "whatsapp", "work");
      writeCreds(credsDir);
    });
  });

  it("migrates legacy secretref-env markers on SecretRef credential paths", () => {
    const res = normalizeCompatibilityConfigValues({
      secrets: {
        defaults: {
          env: "gateway-env",
        },
      },
      channels: {
        discord: {
          token: "secretref-env:DISCORD_BOT_TOKEN",
          accounts: {
            work: {
              token: "secretref-env:DISCORD_WORK_TOKEN",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.channels?.discord?.token).toBeUndefined();
    expect(res.config.channels?.discord?.accounts?.default?.token).toEqual({
      source: "env",
      provider: "gateway-env",
      id: "DISCORD_BOT_TOKEN",
    });
    expect(res.config.channels?.discord?.accounts?.work?.token).toEqual({
      source: "env",
      provider: "gateway-env",
      id: "DISCORD_WORK_TOKEN",
    });
    expect(res.changes).toContain(
      "Moved channels.discord.accounts.default.token secretref-env:DISCORD_BOT_TOKEN marker → structured env SecretRef.",
    );
    expect(res.changes).toContain(
      "Moved channels.discord.accounts.work.token secretref-env:DISCORD_WORK_TOKEN marker → structured env SecretRef.",
    );
  });

  it("leaves invalid legacy secretref-env markers for validation to reject", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        discord: {
          token: "secretref-env:not-valid",
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.channels?.discord?.token).toBe("secretref-env:not-valid");
    expect(res.changes).toEqual([]);
  });

  it("moves WhatsApp access defaults into accounts.default for named accounts", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          groupPolicy: "open",
          groupAllowFrom: [],
          accounts: {
            work: {
              enabled: true,
              authDir: "/tmp/wa-work",
            },
          },
        },
      },
    });

    expect(res.config.channels?.whatsapp?.dmPolicy).toBeUndefined();
    expect(res.config.channels?.whatsapp?.allowFrom).toBeUndefined();
    expect(res.config.channels?.whatsapp?.groupPolicy).toBeUndefined();
    expect(res.config.channels?.whatsapp?.groupAllowFrom).toBeUndefined();
    expect(res.config.channels?.whatsapp?.accounts?.default).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["+15550001111"],
      groupPolicy: "open",
      groupAllowFrom: [],
    });
    expect(res.changes).toContain(
      "Moved channels.whatsapp single-account top-level values into channels.whatsapp.accounts.default.",
    );
  });
  it("migrates browser ssrfPolicy allowPrivateNetwork to dangerouslyAllowPrivateNetwork", () => {
    const res = normalizeCompatibilityConfigValues({
      browser: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          allowedHostnames: ["localhost"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(
      (res.config.browser?.ssrfPolicy as Record<string, unknown> | undefined)?.allowPrivateNetwork,
    ).toBeUndefined();
    expect(res.config.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(true);
    expect(res.config.browser?.ssrfPolicy?.allowedHostnames).toEqual(["localhost"]);
    expect(res.changes).toContain(
      "Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (true).",
    );
  });

  it("normalizes conflicting browser SSRF alias keys without changing effective behavior", () => {
    const res = normalizeCompatibilityConfigValues({
      browser: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          dangerouslyAllowPrivateNetwork: false,
        },
      },
    } as unknown as OpenClawConfig);

    expect(
      (res.config.browser?.ssrfPolicy as Record<string, unknown> | undefined)?.allowPrivateNetwork,
    ).toBeUndefined();
    expect(res.config.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(true);
    expect(res.changes).toContain(
      "Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (true).",
    );
  });

  it("migrates nano-banana skill config to native image generation config", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        entries: {
          "nano-banana-pro": {
            enabled: true,
            apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
          },
        },
      },
    });

    expect(res.config.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "google/gemini-3-pro-image-preview",
    });
    expect(res.config.models?.providers?.google?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "GEMINI_API_KEY",
    });
    expect(res.config.models?.providers?.google?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(res.config.models?.providers?.google?.models).toEqual([]);
    expect(res.config.skills?.entries).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved skills.entries.nano-banana-pro → agents.defaults.imageGenerationModel.primary (google/gemini-3-pro-image-preview).",
      "Moved skills.entries.nano-banana-pro.apiKey → models.providers.google.apiKey.",
      "Removed legacy skills.entries.nano-banana-pro.",
    ]);
  });

  it("removes deprecated commands.modelsWrite from legacy configs", () => {
    const res = normalizeCompatibilityConfigValues({
      commands: {
        text: true,
        modelsWrite: false,
      },
    } as unknown as OpenClawConfig);

    expect(res.config.commands).toEqual({ text: true });
    expect(res.changes).toContain(
      "Removed deprecated commands.modelsWrite (/models add is deprecated).",
    );
  });

  it("migrates legacy OpenAI provider api values to OpenAI completions", () => {
    const res = normalizeCompatibilityConfigValues({
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai",
            models: [
              {
                id: "openai/gpt-4o-mini",
                name: "OpenRouter GPT-4o Mini",
                api: "openai",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.models?.providers?.openrouter?.api).toBe("openai-completions");
    expect(res.config.models?.providers?.openrouter?.models?.[0]?.api).toBe("openai-completions");
    expect(res.changes).toContain(
      'Moved models.providers.openrouter.api "openai" → "openai-completions".',
    );
    expect(res.changes).toContain(
      'Moved models.providers.openrouter.models[0].api "openai" → "openai-completions".',
    );
  });

  it("marks legacy untagged /models add OpenAI Codex metadata rows for doctor repair", () => {
    const res = normalizeCompatibilityConfigValues({
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [
              {
                id: "gpt-5.5",
                name: "gpt-5.5",
                api: "openai-codex-responses",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
                contextWindow: 400_000,
                contextTokens: 272_000,
                maxTokens: 128_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.models?.providers?.["openai-codex"]?.models?.[0]).toMatchObject({
      id: "gpt-5.5",
      metadataSource: "models-add",
    });
    expect(res.changes).toContain(
      "Marked models.providers.openai-codex.models.gpt-5.5 as /models add metadata so official OpenAI Codex metadata can override it.",
    );
  });

  it("does not mark untagged manual OpenAI Codex metadata overrides", () => {
    const res = normalizeCompatibilityConfigValues({
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [
              {
                id: "gpt-5.5",
                name: "gpt-5.5",
                api: "openai-codex-responses",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 0 },
                contextWindow: 555_555,
                contextTokens: 111_111,
                maxTokens: 22_222,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config).toEqual({
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [
              {
                id: "gpt-5.5",
                name: "gpt-5.5",
                api: "openai-codex-responses",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 0 },
                contextWindow: 555_555,
                contextTokens: 111_111,
                maxTokens: 22_222,
              },
            ],
          },
        },
      },
    });
    expect(res.changes).toEqual([]);
  });

  it("migrates legacy Codex primary refs to OpenAI refs plus explicit Codex runtime", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          agentRuntime: { id: "auto", fallback: "pi" },
          model: {
            primary: "codex/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6", "codex/gpt-5.4-mini"],
          },
          models: {
            "codex/gpt-5.5": { alias: "legacy-codex" },
            "openai/gpt-5.5": { alias: "gpt", params: { temperature: 0.2 } },
            "codex/gpt-5.4-mini": {},
          },
        },
        list: [
          {
            id: "reviewer",
            model: "codex/gpt-5.4-mini",
          },
        ],
      },
    } as unknown as OpenClawConfig);

    expect(res.config.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4-mini"],
    });
    expect(res.config.agents?.defaults?.agentRuntime).toEqual({
      id: "codex",
      fallback: "pi",
    });
    expect(res.config.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt", params: { temperature: 0.2 } },
      "openai/gpt-5.4-mini": {},
    });
    expect(res.config.agents?.list?.[0]).toMatchObject({
      id: "reviewer",
      agentRuntime: { id: "codex" },
      model: "openai/gpt-5.4-mini",
    });
    expect(res.changes).toEqual(
      expect.arrayContaining([
        "Moved agents.defaults.model legacy runtime primary refs to canonical provider refs and selected codex runtime.",
        "Moved agents.defaults.models legacy runtime keys to canonical provider keys.",
        "Moved agents.list.reviewer.model legacy runtime primary refs to canonical provider refs and selected codex runtime.",
      ]),
    );
  });

  it("does not force Codex harness for legacy fallback-only refs", () => {
    const input = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["codex/gpt-5.4-mini"],
          },
          models: {
            "codex/gpt-5.4-mini": { alias: "legacy-codex" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const res = normalizeCompatibilityConfigValues(input);

    expect(res.config).toEqual(input);
    expect(res.changes).toEqual([]);
  });

  it("migrates legacy Claude CLI primary refs to Anthropic refs plus explicit runtime", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          model: {
            primary: "claude-cli/claude-opus-4-7",
            fallbacks: ["claude-cli/claude-sonnet-4-6"],
          },
          models: {
            "claude-cli/claude-opus-4-7": { alias: "Opus" },
            "anthropic/claude-opus-4-7": { alias: "Anthropic Opus" },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-7",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(res.config.agents?.defaults?.agentRuntime).toEqual({ id: "claude-cli" });
    expect(res.config.agents?.defaults?.models).toEqual({
      "anthropic/claude-opus-4-7": { alias: "Anthropic Opus" },
    });
  });

  it("migrates legacy Codex CLI primary refs to OpenAI refs plus explicit runtime", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          model: {
            primary: "codex-cli/gpt-5.5",
            fallbacks: ["codex-cli/gpt-5.4-mini"],
          },
          models: {
            "codex-cli/gpt-5.5": { alias: "Codex CLI" },
            "openai/gpt-5.5": { alias: "OpenAI GPT" },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4-mini"],
    });
    expect(res.config.agents?.defaults?.agentRuntime).toEqual({ id: "codex-cli" });
    expect(res.config.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "OpenAI GPT" },
    });
  });

  it("migrates legacy Gemini CLI primary refs to Google refs plus explicit runtime", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          model: {
            primary: "google-gemini-cli/gemini-3.1-pro-preview",
            fallbacks: ["google-gemini-cli/gemini-3-flash-preview"],
          },
          models: {
            "google-gemini-cli/gemini-3.1-pro-preview": { alias: "Gemini CLI" },
            "google/gemini-3.1-pro-preview": { alias: "Gemini API" },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3-flash-preview"],
    });
    expect(res.config.agents?.defaults?.agentRuntime).toEqual({
      id: "google-gemini-cli",
    });
    expect(res.config.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "Gemini API" },
    });
  });

  it("preserves legacy runtime fallback-only refs because runtime is container-scoped", () => {
    const input = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["claude-cli/claude-sonnet-4-6"],
          },
          models: {
            "claude-cli/claude-sonnet-4-6": { alias: "CLI fallback" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const res = normalizeCompatibilityConfigValues(input);

    expect(res.config).toEqual(input);
    expect(res.changes).toEqual([]);
  });

  it("prefers legacy nano-banana env.GEMINI_API_KEY over skill apiKey during migration", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: "ignored-skill-api-key",
            env: {
              GEMINI_API_KEY: "env-gemini-key",
            },
          },
        },
      },
    });

    expect(res.config.models?.providers?.google?.apiKey).toBe("env-gemini-key");
    expect(res.config.models?.providers?.google?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(res.config.models?.providers?.google?.models).toEqual([]);
    expect(res.changes).toContain(
      "Moved skills.entries.nano-banana-pro.env.GEMINI_API_KEY → models.providers.google.apiKey.",
    );
  });

  it("preserves explicit native config while removing legacy nano-banana skill config", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "fal/fal-ai/flux/dev",
          },
        },
      },
      models: {
        providers: {
          google: {
            apiKey: "existing-google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [],
          },
        },
      },
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: "legacy-gemini-key",
          },
          peekaboo: { enabled: true },
        },
      },
    });

    expect(res.config.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "fal/fal-ai/flux/dev",
    });
    expect(res.config.models?.providers?.google?.apiKey).toBe("existing-google-key");
    expect(res.config.skills?.entries).toEqual({
      peekaboo: { enabled: true },
    });
    expect(res.changes).toEqual(["Removed legacy skills.entries.nano-banana-pro."]);
  });

  it("removes nano-banana from skills.allowBundled during migration", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        allowBundled: ["peekaboo", "nano-banana-pro"],
      },
    });

    expect(res.config.skills?.allowBundled).toEqual(["peekaboo"]);
    expect(res.changes).toEqual(["Removed nano-banana-pro from skills.allowBundled."]);
  });

  it("migrates legacy web search provider config to plugin-owned config paths", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        web: {
          search: {
            provider: "gemini",
            maxResults: 5,
            apiKey: "brave-key",
            gemini: {
              apiKey: "gemini-key",
              model: "gemini-2.5-flash",
            },
            firecrawl: {
              apiKey: "firecrawl-key",
              baseUrl: "https://api.firecrawl.dev",
            },
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      provider: "gemini",
      maxResults: 5,
    });
    expect(res.config.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "brave-key",
        },
      },
    });
    expect(res.config.plugins?.entries?.google).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "gemini-key",
          model: "gemini-2.5-flash",
        },
      },
    });
    expect(res.config.plugins?.entries?.firecrawl).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "firecrawl-key",
          baseUrl: "https://api.firecrawl.dev",
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.web.search.apiKey → plugins.entries.brave.config.webSearch.apiKey.",
      "Moved tools.web.search.firecrawl → plugins.entries.firecrawl.config.webSearch.",
      "Moved tools.web.search.gemini → plugins.entries.google.config.webSearch.",
    ]);
  });

  it("merges legacy web search provider config into explicit plugin config without overriding it", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        web: {
          search: {
            provider: "gemini",
            gemini: {
              apiKey: "legacy-gemini-key",
              model: "legacy-model",
            },
          },
        },
      },
      plugins: {
        entries: {
          google: {
            enabled: true,
            config: {
              webSearch: {
                model: "explicit-model",
                baseUrl: "https://generativelanguage.googleapis.com",
              },
            },
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      provider: "gemini",
    });
    expect(res.config.plugins?.entries?.google).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "legacy-gemini-key",
          model: "explicit-model",
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      },
    });
    expect(res.changes).toEqual([
      "Merged tools.web.search.gemini → plugins.entries.google.config.webSearch (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });

  it("keeps explicit plugin-owned web fetch config while filling missing legacy fields", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
            firecrawl: {
              apiKey: "legacy-firecrawl-key",
              baseUrl: "https://api.firecrawl.dev",
              onlyMainContent: false,
            },
          },
        },
      },
      plugins: {
        entries: {
          firecrawl: {
            enabled: true,
            config: {
              webFetch: {
                apiKey: "explicit-firecrawl-key",
                timeoutSeconds: 30,
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(res.config.plugins?.entries?.firecrawl).toEqual({
      enabled: true,
      config: {
        webFetch: {
          apiKey: "explicit-firecrawl-key",
          timeoutSeconds: 30,
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: false,
        },
      },
    });
    expect(res.changes).toEqual([
      "Merged tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });

  it("normalizes talk provider ids without overriding explicit provider config", () => {
    const res = normalizeCompatibilityConfigValues({
      talk: {
        provider: " elevenlabs ",
        providers: {
          " elevenlabs ": {
            voiceId: "voice-123",
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.talk).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "voice-123",
        },
      },
    });
    expect(res.changes).toEqual([
      "Normalized talk.provider/providers shape (trimmed provider ids and merged missing compatibility fields).",
    ]);
  });

  it("does not report talk provider normalization for semantically identical key ordering differences", () => {
    const input = {
      talk: {
        interruptOnSpeech: true,
        silenceTimeoutMs: 1500,
        providers: {
          elevenlabs: {
            apiKey: "secret-key",
            voiceId: "voice-123",
            modelId: "eleven_v3",
          },
        },
        provider: "elevenlabs",
      },
    };

    const res = normalizeCompatibilityConfigValues(input);

    expect(res.config).toEqual(input);
    expect(res.changes).toEqual([]);
  });

  it("migrates tools.message.allowCrossContextSend to canonical crossContext settings", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        message: {
          allowCrossContextSend: true,
          crossContext: {
            allowWithinProvider: false,
            allowAcrossProviders: false,
          },
        },
      },
    });

    expect(res.config.tools?.message).toEqual({
      crossContext: {
        allowWithinProvider: true,
        allowAcrossProviders: true,
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.message.allowCrossContextSend → tools.message.crossContext.allowWithinProvider/allowAcrossProviders (true).",
    ]);
  });

  it("migrates legacy deepgram media options to providerOptions.deepgram", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        media: {
          audio: {
            deepgram: {
              detectLanguage: true,
              smartFormat: true,
            },
            providerOptions: {
              deepgram: {
                punctuate: false,
              },
            },
            models: [
              {
                provider: "deepgram",
                deepgram: {
                  punctuate: true,
                },
              },
            ],
          },
          models: [
            {
              provider: "deepgram",
              deepgram: {
                smartFormat: false,
              },
              providerOptions: {
                deepgram: {
                  detect_language: true,
                },
              },
            },
          ],
        },
      },
    });

    expect(res.config.tools?.media?.audio).toEqual({
      providerOptions: {
        deepgram: {
          detect_language: true,
          smart_format: true,
          punctuate: false,
        },
      },
      models: [
        {
          provider: "deepgram",
          providerOptions: {
            deepgram: {
              punctuate: true,
            },
          },
        },
      ],
    });
    expect(res.config.tools?.media?.models).toEqual([
      {
        provider: "deepgram",
        providerOptions: {
          deepgram: {
            smart_format: false,
            detect_language: true,
          },
        },
      },
    ]);
    expect(res.changes).toEqual([
      "Merged tools.media.audio.deepgram → tools.media.audio.providerOptions.deepgram (filled missing canonical fields from legacy).",
      "Moved tools.media.audio.models[0].deepgram → tools.media.audio.models[0].providerOptions.deepgram.",
      "Merged tools.media.models[0].deepgram → tools.media.models[0].providerOptions.deepgram (filled missing canonical fields from legacy).",
    ]);
  });

  it("normalizes persisted mistral model maxTokens that matched the old context-sized defaults", () => {
    const res = normalizeCompatibilityConfigValues({
      models: {
        providers: {
          mistral: {
            baseUrl: "https://api.mistral.ai/v1",
            api: "openai-completions",
            models: [
              {
                id: "mistral-large-latest",
                name: "Mistral Large",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "magistral-small",
                name: "Magistral Small",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 128000,
              },
            ],
          },
        },
      },
    });

    expect(res.config.models?.providers?.mistral?.models).toEqual([
      expect.objectContaining({
        id: "mistral-large-latest",
        maxTokens: 16384,
      }),
      expect.objectContaining({
        id: "magistral-small",
        maxTokens: 40000,
      }),
    ]);
    expect(res.changes).toEqual([
      "Normalized models.providers.mistral.models[0].maxTokens (262144 → 16384) to avoid Mistral context-window rejects.",
      "Normalized models.providers.mistral.models[1].maxTokens (128000 → 40000) to avoid Mistral context-window rejects.",
    ]);
  });
});
