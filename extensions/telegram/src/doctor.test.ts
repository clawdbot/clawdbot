import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectTelegramInvalidAllowFromWarnings,
  collectTelegramEmptyAllowlistExtraWarnings,
  collectTelegramGroupPolicyWarnings,
  maybeRepairTelegramAllowFromUsernames,
  scanTelegramInvalidAllowFromEntries,
  telegramDoctor,
} from "./doctor.js";

const resolveCommandSecretRefsViaGatewayMock = vi.hoisted(() => vi.fn());
const listTelegramAccountIdsMock = vi.hoisted(() => vi.fn());
const inspectTelegramAccountMock = vi.hoisted(() => vi.fn());
const lookupTelegramChatIdMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime")>(
    "openclaw/plugin-sdk/runtime",
  );
  return {
    ...actual,
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
      tokenStatus: "configured",
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
});
