import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
// Feishu tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { FeishuChannelConfigSchema, FeishuConfigSchema } from "./config-schema.js";

// The NEGATIVE webhook fixtures below spread these bases and add
// verificationToken separately so the GHSA-G353-MGV3-8PCJ opengrep pattern —
// which matches `connectionMode: "webhook"` next to `verificationToken` in
// one object literal (including via constant propagation) — does not flag the
// fixtures that prove the schema rejects them. Positive fixtures stay literal.
const topLevelWebhookBase = {
  connectionMode: "webhook",
  appId: "cli_top",
  appSecret: "secret_top", // pragma: allowlist secret
};
const accountWebhookBase = {
  connectionMode: "webhook",
  appId: "cli_main",
  appSecret: "secret_main", // pragma: allowlist secret
};

function expectSchemaIssue(
  result: ReturnType<typeof FeishuConfigSchema.safeParse>,
  issuePath: string,
) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(issuePath);
  }
}

describe("FeishuConfigSchema webhook validation", () => {
  it("applies top-level defaults", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.domain).toBe("feishu");
    expect(result.connectionMode).toBe("websocket");
    expect(result.webhookPath).toBe("/feishu/events");
    expect(result.dmPolicy).toBe("pairing");
    expect(result.groupPolicy).toBe("allowlist");
    // requireMention has no schema-level default now — it is resolved at runtime
    // through shared channel group-policy resolution, with an open-group override
    // that defaults to false only when requireMention is otherwise unset.
    expect(result.requireMention).toBeUndefined();
  });

  it.each([
    ["legacy-hook", "/legacy-hook"],
    ["legacy-hook/", "/legacy-hook/"],
    ["legacy-hook?tenant=alpha", "/legacy-hook?tenant=alpha"],
    ["/legacy-hook?", "/legacy-hook?"],
    ["/legacy-hook?#", "/legacy-hook"],
    ["/legacy-hook#fragment", "/legacy-hook"],
    ["legacy-hook?tenant=alpha#fragment", "/legacy-hook?tenant=alpha"],
    ["#fragment", "/"],
    ["#?", "/"],
    ["?tenant=alpha#fragment", "/?tenant=alpha"],
    ["/other/../legacy-hook", "/legacy-hook"],
    ["/other/%2e%2e/legacy-hook", "/legacy-hook"],
    ["/other\\..\\legacy-hook", "/legacy-hook"],
    ["//example.com/legacy-hook", "/legacy-hook"],
    ["/\\example.com/legacy-hook", "/legacy-hook"],
    ["https://example.com/legacy-hook/?x=1#fragment", "/legacy-hook/?x=1"],
    ["/legacy hook", "/legacy%20hook"],
    ["/legacy?name=hello world", "/legacy?name=hello%20world"],
    ["/café", "/caf%C3%A9"],
    ["/💬", "/%F0%9F%92%AC"],
    ["/legacy?name=café", "/legacy?name=caf%C3%A9"],
    ["/legacy\tvalue", "/legacyvalue"],
    ["/legacy\nvalue", "/legacyvalue"],
    ["/legacy\u0000value", "/legacy%00value"],
    ["/legacy%23value", "/legacy%23value"],
    ["/legacy%2Fvalue", "/legacy%2Fvalue"],
    ["/legacy%5Cvalue", "/legacy%5Cvalue"],
    ["/legacy%00value", "/legacy%00value"],
    ["/legacy%ZZ", "/legacy%ZZ"],
    ["", "/feishu/events"],
    ["   ", "/feishu/events"],
  ])("accepts only canonical root and account webhook path %j", (webhookPath, canonicalPath) => {
    if (webhookPath === canonicalPath) {
      const result = FeishuConfigSchema.parse({
        webhookPath,
        accounts: { main: { webhookPath } },
      });
      expect(result.webhookPath).toBe(webhookPath);
      expect(result.accounts?.main?.webhookPath).toBe(webhookPath);
      return;
    }

    for (const [input, issuePath] of [
      [{ webhookPath }, "webhookPath"],
      [{ accounts: { main: { webhookPath } } }, "accounts.main.webhookPath"],
    ] as const) {
      const result = FeishuConfigSchema.safeParse(input);
      expectSchemaIssue(result, issuePath);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("openclaw doctor --fix");
      }
    }
  });

  it.each([
    "mailto:hello@example.com",
    "javascript:alert(1)",
    "ftp://host/hook",
    "file:///tmp/hook",
    "//[",
  ])("rejects unsupported root and account webhook URL %j", (webhookPath) => {
    expectSchemaIssue(FeishuConfigSchema.safeParse({ webhookPath }), "webhookPath");
    expectSchemaIssue(
      FeishuConfigSchema.safeParse({ accounts: { main: { webhookPath } } }),
      "accounts.main.webhookPath",
    );
  });

  it("rejects legacy webhook input while preserving the exported canonical default", () => {
    expect(
      FeishuChannelConfigSchema.runtime?.safeParse({
        webhookPath: "https://example.com/hook/?tenant=alpha#fragment",
      }),
    ).toMatchObject({ success: false });
    expect(
      FeishuChannelConfigSchema.runtime?.safeParse({ webhookPath: "/hook/?tenant=alpha" }),
    ).toMatchObject({ success: true, data: { webhookPath: "/hook/?tenant=alpha" } });
    expect(FeishuChannelConfigSchema.schema).toMatchObject({
      properties: {
        webhookPath: { default: "/feishu/events", type: "string" },
        accounts: {
          additionalProperties: { properties: { webhookPath: { type: "string" } } },
        },
      },
    });
  });

  it("does not force top-level policy defaults into account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {},
      },
    });

    expect(result.accounts?.main?.dmPolicy).toBeUndefined();
    expect(result.accounts?.main?.groupPolicy).toBeUndefined();
    expect(result.accounts?.main?.requireMention).toBeUndefined();
  });

  it("normalizes legacy groupPolicy allowall to open", () => {
    const result = FeishuConfigSchema.parse({
      groupPolicy: "allowall",
    });

    expect(result.groupPolicy).toBe("open");
  });

  it("accepts the canonical disabled DM policy", () => {
    expect(FeishuConfigSchema.parse({ dmPolicy: "disabled" }).dmPolicy).toBe("disabled");
    expect(
      FeishuConfigSchema.parse({ accounts: { work: { dmPolicy: "disabled" } } }).accounts?.work
        ?.dmPolicy,
    ).toBe("disabled");
  });

  it("exports legacy groupPolicy as a typed config input", () => {
    const expected = {
      anyOf: [
        { type: "string", enum: ["open", "disabled", "allowlist"] },
        { type: "string", const: "allowall" },
      ],
    };

    expect(FeishuChannelConfigSchema.schema).toMatchObject({
      properties: {
        groupPolicy: expected,
        accounts: {
          additionalProperties: {
            properties: { groupPolicy: expected },
          },
        },
      },
    });
  });

  it("rejects top-level webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expectSchemaIssue(result, "verificationToken");
  });

  it("rejects top-level webhook mode without encryptKey", () => {
    // topLevelWebhookBase (see top of file) keeps the GHSA opengrep pattern
    // from matching this negative fixture.
    const result = FeishuConfigSchema.safeParse({
      ...topLevelWebhookBase,
      verificationToken: "token_top",
    });

    expectSchemaIssue(result, "encryptKey");
  });

  it("accepts top-level webhook mode with verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: "token_top",
      encryptKey: "encrypt_top",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expect(result.success).toBe(true);
  });

  it("rejects account webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main", // pragma: allowlist secret
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.verificationToken");
  });

  it("rejects account webhook mode without encryptKey", () => {
    // accountWebhookBase (see top of file) keeps the GHSA opengrep pattern
    // from matching this negative fixture.
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          ...accountWebhookBase,
          verificationToken: "token_main",
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.encryptKey");
  });

  it("accepts account webhook mode inheriting top-level verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      verificationToken: "token_top",
      encryptKey: "encrypt_top",
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main", // pragma: allowlist secret
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef verificationToken in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: {
        source: "env",
        provider: "default",
        id: "FEISHU_VERIFICATION_TOKEN",
      },
      encryptKey: "encrypt_top",
      appId: "cli_top",
      appSecret: {
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef encryptKey in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: {
        source: "env",
        provider: "default",
        id: "FEISHU_VERIFICATION_TOKEN",
      },
      encryptKey: {
        source: "env",
        provider: "default",
        id: "FEISHU_ENCRYPT_KEY",
      },
      appId: "cli_top",
      appSecret: {
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("FeishuConfigSchema replyInThread", () => {
  it("accepts replyInThread at top level", () => {
    const result = FeishuConfigSchema.parse({ replyInThread: "enabled" });
    expect(result.replyInThread).toBe("enabled");
  });

  it("defaults replyInThread to undefined when not set", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.replyInThread).toBeUndefined();
  });

  it("rejects invalid replyInThread value", () => {
    const result = FeishuConfigSchema.safeParse({ replyInThread: "always" });
    expect(result.success).toBe(false);
  });

  it("accepts replyInThread in group config", () => {
    const result = FeishuConfigSchema.parse({
      groups: { "oc-group": { replyInThread: "enabled" } },
    });
    expect(result.groups?.["oc-group"]?.replyInThread).toBe("enabled");
  });

  it("accepts replyInThread in account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: { replyInThread: "enabled" },
      },
    });
    expect(result.accounts?.main?.replyInThread).toBe("enabled");
  });
});

describe("FeishuConfigSchema optimization flags", () => {
  it("defaults top-level typingIndicator and resolveSenderNames to true", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.typingIndicator).toBe(true);
    expect(result.resolveSenderNames).toBe(true);
  });

  it("accepts only boolean bot ingress", () => {
    expect(FeishuConfigSchema.parse({ allowBots: true }).allowBots).toBe(true);
    expect(() => FeishuConfigSchema.parse({ allowBots: "mentions" })).toThrow();
  });

  it("keeps VC auto-join default-off without forcing account overrides", () => {
    const result = FeishuConfigSchema.parse({ accounts: { main: {} } });
    expect(result.vcAutoJoin).toBeUndefined();
    expect(result.accounts?.main?.vcAutoJoin).toBeUndefined();

    expect(FeishuConfigSchema.parse({ vcAutoJoin: true }).vcAutoJoin).toBe(true);
    expect(
      FeishuConfigSchema.parse({ accounts: { main: { vcAutoJoin: true } } }).accounts?.main
        ?.vcAutoJoin,
    ).toBe(true);
  });

  it("accepts top-level and account-level nested streaming config", () => {
    const result = FeishuConfigSchema.parse({
      streaming: {
        mode: "partial",
        chunkMode: "newline",
        block: { enabled: true, coalesce: { idleMs: 100 } },
      },
      accounts: {
        main: {
          streaming: { mode: "off", block: { enabled: false } },
        },
      },
    });

    expect(result.streaming?.block?.enabled).toBe(true);
    expect(result.streaming?.chunkMode).toBe("newline");
    expect(result.accounts?.main?.streaming).toEqual({
      mode: "off",
      block: { enabled: false },
    });
  });

  it.each([
    ["boolean streaming", { streaming: true }],
    ["flat blockStreaming", { blockStreaming: true }],
    ["flat blockStreamingCoalesce", { blockStreamingCoalesce: { idleMs: 100 } }],
    ["flat chunkMode", { chunkMode: "newline" }],
  ])("rejects legacy %s spelling", (_name, overrides) => {
    expect(FeishuConfigSchema.safeParse(overrides).success).toBe(false);
    expect(FeishuConfigSchema.safeParse({ accounts: { main: overrides } }).success).toBe(false);
  });

  it("accepts account-level optimization flags", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {
          typingIndicator: false,
          resolveSenderNames: false,
        },
      },
    });
    expect(result.accounts?.main?.typingIndicator).toBe(false);
    expect(result.accounts?.main?.resolveSenderNames).toBe(false);
  });
});

describe("FeishuConfigSchema TTS overrides", () => {
  it("accepts top-level and account-level TTS overrides", () => {
    const result = FeishuConfigSchema.parse({
      tts: {
        auto: "always",
        provider: "openai",
        providers: {
          openai: {
            voice: "alloy",
          },
        },
      },
      accounts: {
        english: {
          tts: {
            providers: {
              openai: {
                voice: "shimmer",
              },
            },
          },
        },
      },
    });

    expect(result.tts).toEqual({
      auto: "always",
      provider: "openai",
      providers: {
        openai: {
          voice: "alloy",
        },
      },
    });
    expect(result.accounts?.english?.tts).toEqual({
      providers: {
        openai: {
          voice: "shimmer",
        },
      },
    });
  });
});

describe("FeishuConfigSchema actions", () => {
  it("accepts opt-in stickers at channel and account scope without changing defaults", () => {
    expect(FeishuConfigSchema.parse({}).actions?.sticker).toBeUndefined();
    const result = FeishuConfigSchema.parse({
      actions: { sticker: true },
      accounts: { work: { actions: { sticker: false } } },
    });
    expect(result.actions?.sticker).toBe(true);
    expect(result.accounts?.work?.actions?.sticker).toBe(false);
    expect(FeishuConfigSchema.safeParse({ actions: { sticker: "true" } }).success).toBe(false);
    expect(FeishuChannelConfigSchema.schema).toMatchObject({
      properties: {
        actions: { properties: { sticker: { type: "boolean" } } },
        accounts: {
          additionalProperties: {
            properties: { actions: { properties: { sticker: { type: "boolean" } } } },
          },
        },
      },
    });
  });
  it("accepts top-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      actions: { reactions: false },
    });
    expect(result.actions?.reactions).toBe(false);
  });

  it("accepts account-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {
          actions: { reactions: false },
        },
      },
    });
    expect(result.accounts?.main?.actions?.reactions).toBe(false);
  });
});

describe("FeishuConfigSchema stickerSets", () => {
  const entry = { file_received: ["thumbs up", "赞", "👍"] };

  function expectCatalogValidation(value: Record<string, unknown>, accepted: boolean) {
    expect(FeishuConfigSchema.safeParse(value).success, "Zod validation").toBe(accepted);
    const result = validateJsonSchemaValue({
      schema: FeishuChannelConfigSchema.schema,
      cacheKey: "feishu-sticker-catalog-test",
      value,
      applyDefaults: true,
    });
    expect(result.ok, "exported JSON Schema validation").toBe(accepted);
    if (result.ok) {
      expect(result.value).toMatchObject(value);
    }
  }

  it("accepts bounded bot catalogs only at channel scope", () => {
    const stickerSets = {
      "bot-without-prefix": entry,
      ["a".repeat(128)]: Object.fromEntries(
        Array.from({ length: 256 }, (_, index) => [
          `file_${index}`.padEnd(512, "界"),
          Array.from({ length: 8 }, () => "赞".repeat(64)),
        ]),
      ),
      ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`bot_${index}`, {}])),
    };
    expectCatalogValidation({ stickerSets }, true);
    expect(FeishuConfigSchema.parse({ stickerSets }).stickerSets).toEqual(stickerSets);
    expect(FeishuConfigSchema.parse({}).stickerSets).toBeUndefined();
    expectCatalogValidation({ accounts: { work: { stickerSets } } }, false);
  });

  it.each([
    ["too many bots", Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`bot_${i}`, {}]))],
    ["empty app ID", { "": entry }],
    ["padded app ID", { " bot ": entry }],
    ["long app ID", { ["a".repeat(129)]: entry }],
    [
      "too many entries",
      { bot: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`file_${i}`, ["yes"]])) },
    ],
    ["old array shape", { bot: [{ fileKey: "file_received", keywords: ["yes"] }] }],
    ["empty keywords", { bot: { file_received: [] } }],
    ["too many keywords", { bot: { file_received: Array(9).fill("yes") } }],
    ["blank keyword", { bot: { file_received: ["  "] } }],
    ["padded keyword", { bot: { file_received: [" yes "] } }],
    ["long keyword", { bot: { file_received: ["x".repeat(65)] } }],
    ["non-string keyword", { bot: { file_received: [12] } }],
    ["padded key", { bot: { " file_received ": ["yes"] } }],
    ["long key", { bot: { ["x".repeat(513)]: ["yes"] } }],
    ["path key", { bot: { "../sticker": ["yes"] } }],
    ["control key", { bot: { "file\u0000key": ["yes"] } }],
    ["unpaired surrogate key", { bot: { "\ud800": ["yes"] } }],
    ["unpaired surrogate keyword", { bot: { file_received: ["\udfff"] } }],
    ["unpaired surrogate app ID", { "\ud800": entry }],
  ])("rejects %s", (_name, stickerSets) => {
    expectCatalogValidation({ stickerSets }, false);
  });

  it.each(["👍", "e\u0301", "👋🏽", "👩‍💻"])(
    "uses Unicode scalar bounds consistently for %s",
    (unit) => {
      const bounded = (limit: number) => Array.from(unit.repeat(limit)).slice(0, limit).join("");
      const appId = bounded(128);
      const fileKey = bounded(512);
      const keyword = bounded(64);
      expectCatalogValidation({ stickerSets: { [appId]: { [fileKey]: [keyword] } } }, true);
      expectCatalogValidation({ stickerSets: { [appId + "x"]: entry } }, false);
      expectCatalogValidation({ stickerSets: { bot: { [fileKey + "x"]: ["yes"] } } }, false);
      expectCatalogValidation({ stickerSets: { bot: { file_received: [keyword + "x"] } } }, false);
    },
  );

  it.each([" ", "\n", "\t", "\u00a0", "\u2028", "\ufeff"])(
    "rejects stored padding %j",
    (padding) => {
      for (const padded of [`${padding}value`, `value${padding}`]) {
        expectCatalogValidation({ stickerSets: { [padded]: entry } }, false);
        expectCatalogValidation({ stickerSets: { bot: { [padded]: ["yes"] } } }, false);
        expectCatalogValidation({ stickerSets: { bot: { file_received: [padded] } } }, false);
      }
    },
  );
});

describe("FeishuConfigSchema defaultAccount", () => {
  it("accepts defaultAccount when it matches an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        "router-d": { appId: "cli_router", appSecret: "secret_router" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects defaultAccount when it does not match an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        backup: { appId: "cli_backup", appSecret: "secret_backup" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("defaultAccount");
    }
  });
});
