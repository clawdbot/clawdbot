// Telegram tests cover doctor plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telegramDoctor } from "./doctor.js";

const resolveCommandSecretRefsViaGatewayMock = vi.hoisted(() => vi.fn());
const listTelegramAccountIdsMock = vi.hoisted(() => vi.fn());
const inspectTelegramAccountMock = vi.hoisted(() => vi.fn());
const lookupTelegramChatIdMock = vi.hoisted(() => vi.fn());
const DOCTOR_FIX_COMMAND = "openclaw doctor --fix";

async function collectPreviewWarnings(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const collect = telegramDoctor.collectPreviewWarnings;
  if (!collect) {
    throw new Error("expected Telegram preview warning collector");
  }
  return await collect({ cfg, doctorFixCommand: DOCTOR_FIX_COMMAND, env });
}

async function repairConfig(cfg: OpenClawConfig) {
  const repair = telegramDoctor.repairConfig;
  if (!repair) {
    throw new Error("expected Telegram config repair adapter");
  }
  return await repair({ cfg, doctorFixCommand: DOCTOR_FIX_COMMAND });
}

function collectEmptyAllowlistWarnings(
  params: Parameters<NonNullable<typeof telegramDoctor.collectEmptyAllowlistExtraWarnings>>[0],
) {
  const collect = telegramDoctor.collectEmptyAllowlistExtraWarnings;
  if (!collect) {
    throw new Error("expected Telegram empty-allowlist warning collector");
  }
  return collect(params);
}

vi.mock("openclaw/plugin-sdk/runtime", () => {
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
    if (!normalize) {
      throw new Error("expected telegram compatibility normalizer");
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
    for (const change of [
      "Moved channels.telegram.streamMode → channels.telegram.streaming.mode (block).",
      "Moved channels.telegram.chunkMode → channels.telegram.streaming.chunkMode.",
      "Moved channels.telegram.blockStreaming → channels.telegram.streaming.block.enabled.",
      "Moved channels.telegram.draftChunk → channels.telegram.streaming.preview.chunk.",
      "Moved channels.telegram.accounts.work.streaming (boolean) → channels.telegram.accounts.work.streaming.mode (off).",
      "Moved channels.telegram.accounts.work.blockStreamingCoalesce → channels.telegram.accounts.work.streaming.block.coalesce.",
    ]) {
      expect(result.changes).toContain(change);
    }
  });

  it("does not duplicate streaming.mode change messages when streamMode wins over boolean streaming", () => {
    const normalize = telegramDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("expected telegram compatibility normalizer");
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

  it("removes retired DM thread reply policy keys", () => {
    const normalize = telegramDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("expected telegram compatibility normalizer");
    }

    const result = normalize({
      cfg: {
        channels: {
          telegram: {
            dm: { threadReplies: "inbound" },
            direct: {
              "123": { threadReplies: "always", requireTopic: true },
            },
            accounts: {
              work: {
                dm: { threadReplies: "off" },
                direct: {
                  "456": { threadReplies: "inbound", systemPrompt: "Support" },
                },
              },
            },
          },
        },
      } as never,
    });

    const telegram = result.config.channels?.telegram;
    expect(telegram?.dm).toBeUndefined();
    expect(telegram?.direct?.["123"]).toEqual({ requireTopic: true });
    expect(telegram?.accounts?.work?.dm).toBeUndefined();
    expect(telegram?.accounts?.work?.direct?.["456"]).toEqual({ systemPrompt: "Support" });
    expect(result.changes).toEqual([
      "Removed channels.telegram.dm.threadReplies; DM topic sessions now follow Telegram getMe.has_topics_enabled.",
      "Removed channels.telegram.direct.123.threadReplies; DM topic sessions now follow Telegram getMe.has_topics_enabled.",
      "Removed channels.telegram.accounts.work.dm.threadReplies; DM topic sessions now follow Telegram getMe.has_topics_enabled.",
      "Removed channels.telegram.accounts.work.direct.456.threadReplies; DM topic sessions now follow Telegram getMe.has_topics_enabled.",
    ]);
  });

  it("removes empty retired DM policy stanzas", () => {
    const normalize = telegramDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("expected telegram compatibility normalizer");
    }

    const result = normalize({
      cfg: {
        channels: {
          telegram: {
            dm: {},
            accounts: {
              work: {
                dm: {},
              },
            },
          },
        },
      } as never,
    });

    const telegram = result.config.channels?.telegram;
    expect(telegram?.dm).toBeUndefined();
    expect(telegram?.accounts?.work?.dm).toBeUndefined();
    expect(result.changes).toEqual([
      "Removed channels.telegram.dm.",
      "Removed channels.telegram.accounts.work.dm.",
    ]);
  });

  it("removes retired native draft preview keys", () => {
    const normalize = telegramDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("expected telegram compatibility normalizer");
    }

    const result = normalize({
      cfg: {
        channels: {
          telegram: {
            streaming: {
              mode: "partial",
              preview: {
                toolProgress: true,
                nativeToolProgress: true,
                nativeToolProgressAllowFrom: ["123"],
              },
            },
            accounts: {
              work: {
                streaming: {
                  preview: {
                    nativeToolProgress: true,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    const telegram = result.config.channels?.telegram;
    expect(telegram?.streaming).toEqual({
      mode: "partial",
      preview: {
        toolProgress: true,
      },
    });
    expect(telegram?.accounts?.work?.streaming).toBeUndefined();
    expect(result.changes).toEqual([
      "Removed channels.telegram.streaming.preview native draft keys; Telegram previews now use rich send/edit messages.",
      "Removed channels.telegram.accounts.work.streaming.preview native draft keys; Telegram previews now use rich send/edit messages.",
    ]);
  });

  it("removes retired group history context mode keys", () => {
    expect(
      telegramDoctor.legacyConfigRules?.some((rule) =>
        rule.match?.(
          {
            includeGroupHistoryContext: "mention-only",
          },
          {},
        ),
      ),
    ).toBe(true);
    expect(
      telegramDoctor.legacyConfigRules?.some((rule) =>
        rule.match?.(
          {
            work: { includeGroupHistoryContext: "none" },
          },
          {},
        ),
      ),
    ).toBe(true);

    const normalize = telegramDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("expected telegram compatibility normalizer");
    }

    const result = normalize({
      cfg: {
        channels: {
          telegram: {
            includeGroupHistoryContext: "none",
            historyLimit: 12,
            accounts: {
              work: {
                includeGroupHistoryContext: "none",
                historyLimit: 4,
              },
              ops: {
                includeGroupHistoryContext: "recent",
              },
            },
          },
        },
      } as never,
    });

    const telegram = result.config.channels?.telegram;
    expect(Object.hasOwn(telegram ?? {}, "includeGroupHistoryContext")).toBe(false);
    expect(telegram?.historyLimit).toBe(0);
    expect(Object.hasOwn(telegram?.accounts?.work ?? {}, "includeGroupHistoryContext")).toBe(false);
    expect(telegram?.accounts?.work?.historyLimit).toBe(0);
    expect(Object.hasOwn(telegram?.accounts?.ops ?? {}, "includeGroupHistoryContext")).toBe(false);
    expect(telegram?.accounts?.ops?.historyLimit).toBe(12);
    expect(result.changes).toEqual([
      "Removed channels.telegram.includeGroupHistoryContext and set historyLimit to 0; Telegram group history is always on for groups and bounded by historyLimit.",
      "Removed channels.telegram.accounts.work.includeGroupHistoryContext and set historyLimit to 0; Telegram group history is always on for groups and bounded by historyLimit.",
      "Removed channels.telegram.accounts.ops.includeGroupHistoryContext and set historyLimit to 12; Telegram group history is always on for groups and bounded by historyLimit.",
    ]);
  });

  it("finds invalid allowFrom entries across scopes", async () => {
    const warnings = await collectPreviewWarnings({
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

    expect(warnings).toContain(
      "- Telegram allowFrom contains 4 invalid sender entries (e.g. @top); Telegram authorization requires positive numeric sender user IDs.",
    );
  });

  it("formats group-policy and empty-allowlist warnings", () => {
    const warnings = collectEmptyAllowlistWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: { ops: { allow: true } },
      },
      channelName: "telegram",
      prefix: "channels.telegram",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('groupPolicy is "allowlist"');
  });

  it("warns when Telegram groups use a non-object shape", async () => {
    const cfg = {
      channels: {
        telegram: {
          groups: ["-1001234567890"],
          accounts: {
            work: {
              groups: null,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const warnings = await collectPreviewWarnings(cfg);
    expect(warnings[0]).toContain("object map keyed by Telegram group/chat id");
    expect(warnings[1]).toContain('channels.telegram.groups."-1001234567890".topics."99"');
    expect(warnings[1]).toContain(DOCTOR_FIX_COMMAND);
  });

  it("repairs @username entries to numeric ids", async () => {
    lookupTelegramChatIdMock.mockResolvedValue("111");

    const result = await repairConfig({
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
    const result = await repairConfig({
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

    const result = await repairConfig({
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

  it("formats invalid allowFrom warnings", async () => {
    const warnings = await collectPreviewWarnings({
      channels: { telegram: { allowFrom: ["@top"] } },
    } as unknown as OpenClawConfig);

    expect(warnings[0]).toContain("invalid sender entries");
    expect(warnings[1]).toContain(DOCTOR_FIX_COMMAND);
  });

  it("warns and repairs Telegram apiRoot values that include the bot endpoint", async () => {
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

    expect(await collectPreviewWarnings(cfg)).toContain(
      "- channels.telegram.apiRoot points at a full Telegram bot endpoint; apiRoot must be the Bot API root only. This can make startup calls like deleteWebhook, deleteMyCommands, and setMyCommands fail with 404 even when direct curl commands work.",
    );

    const repaired = await repairConfig(cfg);
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

    const warnings = await collectPreviewWarnings(cfg);
    expect(warnings[0]).toContain("selected quote replies");
    expect(warnings[0]).toContain('"Working" tool-progress preview');
    expect(warnings[0]).toContain("Current-message replies without selected quote text");
    expect(warnings[1]).toContain("streaming.preview.toolProgress: false");
  });

  it("warns for the implicit default Telegram account when accounts is empty", async () => {
    const cfg = {
      channels: {
        telegram: {
          replyToMode: "all",
          accounts: {},
        },
      },
    } as unknown as OpenClawConfig;

    expect((await collectPreviewWarnings(cfg)).join("\n")).toContain(
      'channels.telegram has replyToMode: "all"',
    );
  });

  it("uses merged Telegram account config for selected quote tool-progress warnings", async () => {
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

    const warnings = (await collectPreviewWarnings(cfg)).join("\n");
    expect(warnings).toContain('channels.telegram.accounts.work has replyToMode: "batched"');
    expect(warnings).not.toContain("channels.telegram.accounts.quiet");
  });

  it("skips selected quote tool-progress warning when preview progress is disabled", async () => {
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

    expect((await collectPreviewWarnings(cfg)).join("\n")).not.toContain("selected quote replies");
  });

  it("skips selected quote tool-progress warning when preview streaming is off or block streaming owns delivery", async () => {
    expect(
      (
        await collectPreviewWarnings({
          channels: {
            telegram: {
              replyToMode: "first",
              streaming: false,
            },
          },
        } as unknown as OpenClawConfig)
      ).join("\n"),
    ).not.toContain("selected quote replies");

    expect(
      (
        await collectPreviewWarnings({
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
        } as unknown as OpenClawConfig)
      ).join("\n"),
    ).not.toContain("selected quote replies");
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
    const missingEnvWarning =
      "- channels.telegram: default account has no available bot token, and TELEGRAM_BOT_TOKEN is absent in this doctor environment. After migration, verify TELEGRAM_BOT_TOKEN is present in the state-dir .env or configure channels.telegram.botToken / channels.telegram.accounts.default.botToken as a SecretRef.";
    expect(await collectPreviewWarnings(cfg, {})).toContain(missingEnvWarning);

    inspectTelegramAccountMock.mockReturnValueOnce({
      enabled: true,
      token: "123:tok",
      tokenSource: "env",
      tokenStatus: "available",
      configured: true,
      config: {},
    });
    expect(await collectPreviewWarnings(cfg, { TELEGRAM_BOT_TOKEN: "123:tok" })).not.toContain(
      missingEnvWarning,
    );
  });

  it("does not warn about TELEGRAM_BOT_TOKEN when a non-default account is selected", async () => {
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

    expect((await collectPreviewWarnings(cfg, {})).join("\n")).not.toContain(
      "TELEGRAM_BOT_TOKEN is absent",
    );
  });
});
