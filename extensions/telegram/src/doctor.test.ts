import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectTelegramInvalidAllowFromWarnings,
  collectTelegramApiRootWarnings,
  collectTelegramEmptyAllowlistExtraWarnings,
  collectTelegramGroupPolicyWarnings,
  collectTelegramMissingEnvTokenWarnings,
  collectTelegramSelectedQuoteToolProgressWarnings,
  maybeRepairTelegramApiRoots,
  maybeRepairTelegramAllowFromUsernames,
  scanTelegramBotEndpointApiRoots,
  scanTelegramInvalidAllowFromEntries,
  scanTelegramSelectedQuoteToolProgressWarnings,
  telegramDoctor,
} from "./doctor.js";

const resolveCommandSecretRefsViaGatewayMock = vi.hoisted(() => vi.fn());
const listTelegramAccountIdsMock = vi.hoisted(() => vi.fn());
const inspectTelegramAccountMock = vi.hoisted(() => vi.fn());
const lookupTelegramChatIdMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-secret-resolution", () => {
  return {
    getChannelsCommandSecretTargetIds: () => ["channels"],
    resolveCommandSecretRefsViaGateway: resolveCommandSecretRefsViaGatewayMock,
  };
});

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    listTelegramAccountIds: listTelegramAccountIdsMock,
  };
});

vi.mock("./account-inspect.js", async () => {
  const actual =
    await vi.importActual<typeof import("./account-inspect.js")>("./account-inspect.js");
  return {
    ...actual,
    inspectTelegramAccount: inspectTelegramAccountMock,
  };
});

vi.mock("./api-fetch.js", async () => {
  const actual = await vi.importActual<typeof import("./api-fetch.js")>("./api-fetch.js");
  return {
    ...actual,
    lookupTelegramChatId: lookupTelegramChatIdMock,
  };
});

describe("telegram doctor", () => {
  beforeEach(() => {
    resolveCommandSecretRefsViaGatewayMock.mockReset().mockImplementation(async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }));
    listTelegramAccountIdsMock.mockReset().mockReturnValue(["default"]);
    inspectTelegramAccountMock.mockReset().mockReturnValue({
      enabled: true,
      token: "tok",
      tokenSource: "config",
      tokenStatus: "available",
    });
    lookupTelegramChatIdMock.mockReset();
  });

  it("normalizes legacy telegram streaming aliases into the nested streaming shape", () => {
    const normalize = telegramDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          telegram: {
            streamMode: "block",
            chunkMode: "newline",
            blockStreaming: true,
            draftChunk: {
              minChars: 120,
            },
            accounts: {
              work: {
                streaming: false,
                blockStreamingCoalesce: {
                  idleMs: 250,
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.telegram?.streaming).toEqual({
      mode: "block",
      chunkMode: "newline",
      block: {
        enabled: true,
      },
      preview: {
        chunk: {
          minChars: 120,
        },
      },
    });
    expect(result.config.channels?.telegram?.accounts?.work?.streaming).toEqual({
      mode: "off",
      block: {
        coalesce: {
          idleMs: 250,
        },
      },
    });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.telegram.streamMode → channels.telegram.streaming.mode (block).",
        "Moved channels.telegram.chunkMode → channels.telegram.streaming.chunkMode.",
        "Moved channels.telegram.blockStreaming → channels.telegram.streaming.block.enabled.",
        "Moved channels.telegram.draftChunk → channels.telegram.streaming.preview.chunk.",
        "Moved channels.telegram.accounts.work.streaming (boolean) → channels.telegram.accounts.work.streaming.mode (off).",
        "Moved channels.telegram.accounts.work.blockStreamingCoalesce → channels.telegram.accounts.work.streaming.block.coalesce.",
      ]),
    );
  });

  it("does not duplicate streaming.mode change messages when streamMode wins over boolean streaming", () => {
    const normalize = telegramDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          telegram: {
            streamMode: "block",
            streaming: false,
          },
        },
      } as never,
    });

    expect(result.config.channels?.telegram?.streaming).toEqual({
      mode: "block",
    });
    expect(
      result.changes.filter((change) => change.includes("channels.telegram.streaming.mode")),
    ).toEqual(["Moved channels.telegram.streamMode → channels.telegram.streaming.mode (block)."]);
  });

  it("finds invalid allowFrom entries across scopes", () => {
    const hits = scanTelegramInvalidAllowFromEntries({
      channels: {
        telegram: {
          allowFrom: ["@top"],
          accounts: {
            work: {
              allowFrom: ["tg:@work", -1001234567890],
              groups: { "-100123": { topics: { "99": { allowFrom: ["@topic"] } } } },
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(hits).toEqual([
      { path: "channels.telegram.allowFrom", entry: "@top" },
      { path: "channels.telegram.accounts.work.allowFrom", entry: "tg:@work" },
      { path: "channels.telegram.accounts.work.allowFrom", entry: "-1001234567890" },
      {
        path: "channels.telegram.accounts.work.groups.-100123.topics.99.allowFrom",
        entry: "@topic",
      },
    ]);
  });

  it("formats group-policy and empty-allowlist warnings", () => {
    const warnings = collectTelegramGroupPolicyWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: { ops: { allow: true } },
      },
      prefix: "channels.telegram",
    });
    expect(warnings[0]).toContain('groupPolicy is "allowlist"');

    expect(
      collectTelegramEmptyAllowlistExtraWarnings({
        account: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
          groups: { ops: { allow: true } },
        },
        channelName: "telegram",
        prefix: "channels.telegram",
      }),
    ).toHaveLength(1);
  });

  it("repairs @username entries to numeric ids", async () => {
    lookupTelegramChatIdMock.mockResolvedValue("111");

    const result = await maybeRepairTelegramAllowFromUsernames({
      channels: {
        telegram: {
          botToken: "123:abc",
          allowFrom: ["@testuser"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.config.channels?.telegram?.allowFrom).toEqual(["111"]);
    expect(result.changes[0]).toContain("@testuser");
  });

  it("surfaces negative chat ids as invalid allowFrom sender entries", async () => {
    const result = await maybeRepairTelegramAllowFromUsernames({
      channels: {
        telegram: {
          allowFrom: [-1001234567890],
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.config.channels?.telegram?.allowFrom).toEqual([-1001234567890]);
    expect(result.changes).toEqual([
      "- channels.telegram.allowFrom: invalid sender entry -1001234567890; allowFrom requires positive numeric Telegram user IDs. Move group chat IDs under channels.telegram.groups.",
    ]);
  });

  it("warns when @username entries cannot be resolved because configured tokens are unavailable", async () => {
    resolveCommandSecretRefsViaGatewayMock.mockResolvedValueOnce({
      resolvedConfig: {
        channels: {
          telegram: {
            accounts: {
              inactive: {
                allowFrom: ["@testuser"],
              },
            },
          },
        },
      },
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    listTelegramAccountIdsMock.mockReturnValue(["inactive"]);
    inspectTelegramAccountMock.mockReturnValue({
      enabled: false,
      token: "",
      tokenSource: "env",
      tokenStatus: "configured_unavailable",
      config: {},
    });

    const result = await maybeRepairTelegramAllowFromUsernames({
      channels: {
        telegram: {
          accounts: {
            inactive: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
              allowFrom: ["@testuser"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.config.channels?.telegram?.accounts?.inactive?.allowFrom).toEqual(["@testuser"]);
    expect(result.changes).toEqual([
      "- Telegram account inactive: failed to inspect bot token (configured but unavailable in this command path).",
      "- Telegram allowFrom contains @username entries, but configured Telegram bot credentials are unavailable in this command path; cannot auto-resolve.",
    ]);
  });

  it("formats invalid allowFrom warnings", () => {
    const warnings = collectTelegramInvalidAllowFromWarnings({
      hits: [{ path: "channels.telegram.allowFrom", entry: "@top" }],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings[0]).toContain("invalid sender entries");
    expect(warnings[1]).toContain("openclaw doctor --fix");
  });

  it("warns and repairs Telegram apiRoot values that include the bot endpoint", () => {
    const cfg = {
      channels: {
        telegram: {
          apiRoot: "https://api.telegram.org/bot123456:ABC",
          accounts: {
            work: {
              apiRoot: "https://proxy.example.test/custom/bot234567:DEF/",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const hits = scanTelegramBotEndpointApiRoots(cfg);
    expect(hits.map((hit) => hit.path)).toEqual([
      "channels.telegram.apiRoot",
      "channels.telegram.accounts.work.apiRoot",
    ]);
    expect(
      collectTelegramApiRootWarnings({ hits, doctorFixCommand: "openclaw doctor --fix" }),
    ).toContain(
      "- channels.telegram.apiRoot points at a full Telegram bot endpoint; apiRoot must be the Bot API root only. This can make startup calls like deleteWebhook, deleteMyCommands, and setMyCommands fail with 404 even when direct curl commands work.",
    );

    const repaired = maybeRepairTelegramApiRoots(cfg);
    expect(repaired.config.channels?.telegram?.apiRoot).toBe("https://api.telegram.org");
    expect(repaired.config.channels?.telegram?.accounts?.work?.apiRoot).toBe(
      "https://proxy.example.test/custom",
    );
    expect(repaired.changes).toEqual([
      "- channels.telegram.apiRoot: removed trailing /bot<TOKEN> from Telegram apiRoot.",
      "- channels.telegram.accounts.work.apiRoot: removed trailing /bot<TOKEN> from Telegram apiRoot.",
    ]);
  });

  it("warns when selected quote replies can suppress Telegram tool-progress preview", async () => {
    const cfg = {
      channels: {
        telegram: {
          replyToMode: "first",
        },
      },
    } as unknown as OpenClawConfig;

    const hits = scanTelegramSelectedQuoteToolProgressWarnings(cfg);
    expect(hits).toEqual([{ path: "channels.telegram", replyToMode: "first" }]);

    const warnings = collectTelegramSelectedQuoteToolProgressWarnings({ hits });
    expect(warnings[0]).toContain("selected quote replies");
    expect(warnings[0]).toContain('"Working..." tool-progress preview');
    expect(warnings[0]).toContain("Current-message replies without selected quote text");
    expect(warnings[1]).toContain("streaming.preview.toolProgress: false");
    expect(
      await telegramDoctor.collectPreviewWarnings?.({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("selected quote replies")]));
  });

  it("warns for the implicit default Telegram account when accounts is empty", () => {
    const cfg = {
      channels: {
        telegram: {
          replyToMode: "all",
          accounts: {},
        },
      },
    } as unknown as OpenClawConfig;

    expect(scanTelegramSelectedQuoteToolProgressWarnings(cfg)).toEqual([
      { path: "channels.telegram", replyToMode: "all" },
    ]);
  });

  it("uses merged Telegram account config for selected quote tool-progress warnings", () => {
    listTelegramAccountIdsMock.mockReturnValue(["work", "quiet"]);
    const cfg = {
      channels: {
        telegram: {
          replyToMode: "batched",
          accounts: {
            work: {},
            quiet: {
              replyToMode: "off",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(scanTelegramSelectedQuoteToolProgressWarnings(cfg)).toEqual([
      { path: "channels.telegram.accounts.work", replyToMode: "batched" },
    ]);
  });

  it("skips selected quote tool-progress warning when preview progress is disabled", () => {
    const cfg = {
      channels: {
        telegram: {
          replyToMode: "first",
          streaming: {
            preview: {
              toolProgress: false,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(scanTelegramSelectedQuoteToolProgressWarnings(cfg)).toEqual([]);
  });

  it("skips selected quote tool-progress warning when preview streaming is off or block streaming owns delivery", () => {
    expect(
      scanTelegramSelectedQuoteToolProgressWarnings({
        channels: {
          telegram: {
            replyToMode: "first",
            streaming: false,
          },
        },
      } as unknown as OpenClawConfig),
    ).toEqual([]);

    expect(
      scanTelegramSelectedQuoteToolProgressWarnings({
        channels: {
          telegram: {
            replyToMode: "first",
          },
        },
        agents: {
          defaults: {
            blockStreamingDefault: "on",
          },
        },
      } as unknown as OpenClawConfig),
    ).toEqual([]);
  });

  it("wires apiRoot preview warnings and repair through the doctor adapter", async () => {
    const cfg = {
      channels: {
        telegram: {
          apiRoot: "https://api.telegram.org/bot123456:ABC",
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      await telegramDoctor.collectPreviewWarnings?.({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toContain(
      "- channels.telegram.apiRoot points at a full Telegram bot endpoint; apiRoot must be the Bot API root only. This can make startup calls like deleteWebhook, deleteMyCommands, and setMyCommands fail with 404 even when direct curl commands work.",
    );

    const repaired = await telegramDoctor.repairConfig?.({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    });
    expect(repaired?.config.channels?.telegram?.apiRoot).toBe("https://api.telegram.org");
    expect(repaired?.changes).toEqual([
      "- channels.telegram.apiRoot: removed trailing /bot<TOKEN> from Telegram apiRoot.",
    ]);
  });

  it("warns when default env fallback token is missing after migration", async () => {
    const cfg = {
      channels: {
        telegram: {
          allowFrom: ["123"],
        },
      },
    } as unknown as OpenClawConfig;

    inspectTelegramAccountMock.mockReturnValueOnce({
      enabled: true,
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
      configured: false,
      config: {},
    });
    expect(collectTelegramMissingEnvTokenWarnings({ cfg, env: {} })).toEqual([
      expect.stringContaining("TELEGRAM_BOT_TOKEN is absent"),
    ]);

    inspectTelegramAccountMock.mockReturnValueOnce({
      enabled: true,
      token: "123:tok",
      tokenSource: "env",
      tokenStatus: "available",
      configured: true,
      config: {},
    });
    expect(
      collectTelegramMissingEnvTokenWarnings({ cfg, env: { TELEGRAM_BOT_TOKEN: "123:tok" } }),
    ).toEqual([]);

    inspectTelegramAccountMock.mockReturnValueOnce({
      enabled: true,
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
      configured: false,
      config: {},
    });
    expect(
      await telegramDoctor.collectPreviewWarnings?.({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
        env: {},
      }),
    ).toContainEqual(expect.stringContaining("TELEGRAM_BOT_TOKEN is absent"));
  });

  it("does not warn about TELEGRAM_BOT_TOKEN when a non-default account is selected", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {
              botToken: "123:work",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectTelegramMissingEnvTokenWarnings({ cfg, env: {} })).toEqual([]);
  });
});
