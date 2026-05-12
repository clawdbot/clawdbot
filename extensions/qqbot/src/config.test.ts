import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type JsonSchemaObject, validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { describe, expect, it } from "vitest";
import { qqbotSetupAdapterShared } from "./bridge/config-shared.js";
import {
  DEFAULT_ACCOUNT_ID,
  resolveDefaultQQBotAccountId,
  resolveQQBotAccount,
} from "./bridge/config.js";
import { qqbotSetupPlugin } from "./channel.setup.js";
import { QQBotConfigSchema } from "./config-schema.js";
import { makeQqbotDefaultAccountConfig, makeQqbotSecretRefConfig } from "./qqbot-test-support.js";

function requireQQBotSetup() {
  if (!qqbotSetupPlugin.setup) {
    throw new Error("QQBot setup missing");
  }
  return qqbotSetupPlugin.setup;
}

describe("qqbot config", () => {
  it("accepts top-level speech overrides in the manifest schema", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
    ) as { configSchema: JsonSchemaObject };

    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "qqbot.manifest.speech-overrides",
      value: {
        stt: {
          provider: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "stt-key",
          model: "whisper-1",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts defaultAccount in the manifest schema", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
    ) as { configSchema: JsonSchemaObject };

    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "qqbot.manifest.default-account",
      value: {
        defaultAccount: "bot2",
        accounts: {
          bot2: {
            appId: "654321",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("honors configured defaultAccount when resolving the default QQ Bot account id", () => {
    const cfg = {
      channels: {
        qqbot: {
          defaultAccount: "bot2",
          accounts: {
            bot2: {
              appId: "654321",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveDefaultQQBotAccountId(cfg)).toBe("bot2");
  });

  it("accepts SecretRef-backed credentials in the runtime schema", () => {
    const parsed = QQBotConfigSchema.safeParse({
      defaultAccount: "bot2",
      appId: "123456",
      clientSecret: {
        source: "env",
        provider: "default",
        id: "QQBOT_CLIENT_SECRET",
      },
      allowFrom: ["*"],
      audioFormatPolicy: {
        sttDirectFormats: [".wav"],
        uploadDirectFormats: [".mp3"],
        transcodeEnabled: false,
      },
      urlDirectUpload: false,
      upgradeUrl: "https://docs.openclaw.ai/channels/qqbot",
      upgradeMode: "doc",
      accounts: {
        bot2: {
          appId: "654321",
          clientSecret: {
            source: "env",
            provider: "default",
            id: "QQBOT_CLIENT_SECRET_BOT2",
          },
          allowFrom: ["user-1"],
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts account-level speech overrides as forward-compatible config", () => {
    const parsed = QQBotConfigSchema.safeParse({
      accounts: {
        bot2: {
          appId: "654321",
          stt: {
            provider: "openai",
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("preserves top-level media and upgrade config on the default account", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: "secret-value",
          audioFormatPolicy: {
            sttDirectFormats: [".wav"],
            uploadDirectFormats: [".mp3"],
            transcodeEnabled: false,
          },
          urlDirectUpload: false,
          upgradeUrl: "https://docs.openclaw.ai/channels/qqbot",
          upgradeMode: "hot-reload",
        },
      },
    } as OpenClawConfig;

    const resolved = resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID);

    expect(resolved.clientSecret).toBe("secret-value");
    expect(resolved.config.audioFormatPolicy).toEqual({
      sttDirectFormats: [".wav"],
      uploadDirectFormats: [".mp3"],
      transcodeEnabled: false,
    });
    expect(resolved.config.urlDirectUpload).toBe(false);
    expect(resolved.config.upgradeUrl).toBe("https://docs.openclaw.ai/channels/qqbot");
    expect(resolved.config.upgradeMode).toBe("hot-reload");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg = {
      channels: {
        qqbot: {
          defaultAccount: "bot2",
          accounts: {
            bot2: {
              appId: "654321",
              clientSecret: "secret-value",
              name: "Bot Two",
            },
          },
        },
      },
    } as OpenClawConfig;

    const resolved = resolveQQBotAccount(cfg);

    expect(resolved.accountId).toBe("bot2");
    expect(resolved.appId).toBe("654321");
    expect(resolved.clientSecret).toBe("secret-value");
    expect(resolved.name).toBe("Bot Two");
  });

  it("resolves env SecretRefs on runtime resolution", () => {
    const cfg = makeQqbotSecretRefConfig();
    const previous = process.env.QQBOT_CLIENT_SECRET;

    process.env.QQBOT_CLIENT_SECRET = "resolved-secret";
    try {
      const resolved = resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID);

      expect(resolved.clientSecret).toBe("resolved-secret");
      expect(resolved.secretSource).toBe("config");
    } finally {
      if (previous === undefined) {
        delete process.env.QQBOT_CLIENT_SECRET;
      } else {
        process.env.QQBOT_CLIENT_SECRET = previous;
      }
    }
  });

  it("rejects unresolved non-env SecretRefs on runtime resolution", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: {
            source: "file",
            provider: "default",
            id: "/qqbot/clientSecret",
          },
        },
      },
    } as OpenClawConfig;

    expect(() => resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID)).toThrow(
      'channels.qqbot.clientSecret: unresolved SecretRef "file:default:/qqbot/clientSecret"',
    );
  });

  it("rejects legacy SecretRef marker strings before QQ token exchange", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: "secretref:/QQBOT_CLIENT_SECRET",
        },
      },
    } as OpenClawConfig;

    expect(() => resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID)).toThrow(
      "channels.qqbot.clientSecret: legacy SecretRef marker strings are not valid QQ Bot clientSecret values; use a structured SecretRef object instead.",
    );
  });

  it("allows unresolved SecretRefs for setup/status flows", () => {
    const cfg = makeQqbotSecretRefConfig();

    const resolved = resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID, {
      allowUnresolvedSecretRef: true,
    });

    expect(resolved.clientSecret).toBe("");
    expect(resolved.secretSource).toBe("config");
    expect(qqbotSetupPlugin.config.isConfigured?.(resolved, cfg)).toBe(true);
    expect(qqbotSetupPlugin.config.describeAccount?.(resolved, cfg)?.configured).toBe(true);
  });

  it.each([
    {
      accountId: DEFAULT_ACCOUNT_ID,
      inputAccountId: DEFAULT_ACCOUNT_ID,
      expectedPath: ["channels", "qqbot"],
    },
    {
      accountId: "bot2",
      inputAccountId: "bot2",
      expectedPath: ["channels", "qqbot", "accounts", "bot2"],
    },
  ])("splits --token on the first colon for $accountId", ({ inputAccountId, expectedPath }) => {
    const setup = requireQQBotSetup();

    const next = setup.applyAccountConfig?.({
      cfg: {} as OpenClawConfig,
      accountId: inputAccountId,
      input: {
        token: "102905186:Oi2Mg1Mh2Ni3:Pl7TpBXuHe1OmAYwKi7W",
      },
    }) as Record<string, unknown>;

    const accountConfig = expectedPath.reduce<unknown>((value, key) => {
      if (!value || typeof value !== "object") {
        return undefined;
      }
      return (value as Record<string, unknown>)[key];
    }, next) as Record<string, unknown> | undefined;

    expect(accountConfig).toStrictEqual({
      enabled: true,
      allowFrom: ["*"],
      appId: "102905186",
      clientSecret: "Oi2Mg1Mh2Ni3:Pl7TpBXuHe1OmAYwKi7W",
      clientSecretFile: undefined,
    });
  });

  it("rejects malformed --token consistently across setup paths", () => {
    const runtimeSetup = qqbotSetupAdapterShared;
    const lightweightSetup = requireQQBotSetup();

    const input = { token: "broken", name: "Bad" };

    expect(
      runtimeSetup.validateInput?.({
        cfg: {} as OpenClawConfig,
        accountId: DEFAULT_ACCOUNT_ID,
        input,
      } as never),
    ).toBe("QQBot --token must be in appId:clientSecret format");
    expect(
      lightweightSetup.validateInput?.({
        cfg: {} as OpenClawConfig,
        accountId: DEFAULT_ACCOUNT_ID,
        input,
      } as never),
    ).toBe("QQBot --token must be in appId:clientSecret format");
    expect(
      runtimeSetup.applyAccountConfig?.({
        cfg: {} as OpenClawConfig,
        accountId: DEFAULT_ACCOUNT_ID,
        input,
      } as never),
    ).toStrictEqual({});
    expect(
      lightweightSetup.applyAccountConfig?.({
        cfg: {} as OpenClawConfig,
        accountId: DEFAULT_ACCOUNT_ID,
        input,
      } as never),
    ).toStrictEqual({});
  });

  it("preserves the --use-env add flow across setup paths", () => {
    const runtimeSetup = qqbotSetupAdapterShared;
    const lightweightSetup = requireQQBotSetup();

    const input = { useEnv: true, name: "Env Bot" };

    expect(
      runtimeSetup.applyAccountConfig?.({
        cfg: {} as OpenClawConfig,
        accountId: DEFAULT_ACCOUNT_ID,
        input,
      } as never),
    ).toStrictEqual({
      channels: {
        qqbot: {
          enabled: true,
          allowFrom: ["*"],
          name: "Env Bot",
        },
      },
    });
    expect(
      lightweightSetup.applyAccountConfig?.({
        cfg: {} as OpenClawConfig,
        accountId: DEFAULT_ACCOUNT_ID,
        input,
      } as never),
    ).toStrictEqual({
      channels: {
        qqbot: {
          enabled: true,
          allowFrom: ["*"],
          name: "Env Bot",
        },
      },
    });
  });

  it("uses configured defaultAccount when runtime setup accountId is omitted", () => {
    const runtimeSetup = qqbotSetupAdapterShared;

    expect(
      runtimeSetup.resolveAccountId?.({
        cfg: makeQqbotDefaultAccountConfig(),
        accountId: undefined,
      } as never),
    ).toBe("bot2");
  });

  it("rejects --use-env for named accounts across setup paths", () => {
    const runtimeSetup = qqbotSetupAdapterShared;
    const lightweightSetup = requireQQBotSetup();

    const input = { useEnv: true, name: "Env Bot" };

    expect(
      runtimeSetup.validateInput?.({
        cfg: {} as OpenClawConfig,
        accountId: "bot2",
        input,
      } as never),
    ).toBe("QQBot --use-env only supports the default account");
    expect(
      lightweightSetup.validateInput?.({
        cfg: {} as OpenClawConfig,
        accountId: "bot2",
        input,
      } as never),
    ).toBe("QQBot --use-env only supports the default account");
    expect(
      runtimeSetup.applyAccountConfig?.({
        cfg: {} as OpenClawConfig,
        accountId: "bot2",
        input,
      } as never),
    ).toStrictEqual({});
    expect(
      lightweightSetup.applyAccountConfig?.({
        cfg: {} as OpenClawConfig,
        accountId: "bot2",
        input,
      } as never),
    ).toStrictEqual({});
  });
});
