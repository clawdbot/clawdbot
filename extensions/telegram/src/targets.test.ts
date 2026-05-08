import { describe, expect, it } from "vitest";
import {
  isNumericTelegramSenderUserId,
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
} from "./allow-from.js";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-policy.js";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./normalize.js";
import { installMaybePersistResolvedTelegramTargetTests } from "./target-writeback.test-shared.js";
import {
  isNumericTelegramChatId,
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  parseTelegramTarget,
  stripTelegramInternalPrefixes,
} from "./targets.js";

const numericTelegramTargetNormalizers = [
  { name: "normalizeTelegramChatId", normalize: normalizeTelegramChatId },
  { name: "normalizeTelegramLookupTarget", normalize: normalizeTelegramLookupTarget },
];

describe("stripTelegramInternalPrefixes", () => {
  it("strips telegram prefix", () => {
    expect(stripTelegramInternalPrefixes("telegram:123")).toBe("123");
  });

  it("strips telegram+group prefixes", () => {
    expect(stripTelegramInternalPrefixes("telegram:group:-100123")).toBe("-100123");
  });

  it("does not strip group prefix without telegram prefix", () => {
    expect(stripTelegramInternalPrefixes("group:-100123")).toBe("group:-100123");
  });

  it("is idempotent", () => {
    expect(stripTelegramInternalPrefixes("@mychannel")).toBe("@mychannel");
  });
});

describe("parseTelegramTarget", () => {
  it("parses plain chatId", () => {
    expect(parseTelegramTarget("-1001234567890")).toEqual({
      chatId: "-1001234567890",
      chatType: "group",
    });
  });

  it("parses @username", () => {
    expect(parseTelegramTarget("@mychannel")).toEqual({
      chatId: "@mychannel",
      chatType: "unknown",
    });
  });

  it("parses chatId:topicId format", () => {
    expect(parseTelegramTarget("-1001234567890:123")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 123,
      chatType: "group",
    });
  });

  it("parses chatId:topic:topicId format", () => {
    expect(parseTelegramTarget("-1001234567890:topic:456")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 456,
      chatType: "group",
    });
  });

  it("trims whitespace", () => {
    expect(parseTelegramTarget("  -1001234567890:99  ")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 99,
      chatType: "group",
    });
  });

  it("does not treat non-numeric suffix as topicId", () => {
    expect(parseTelegramTarget("-1001234567890:abc")).toEqual({
      chatId: "-1001234567890:abc",
      chatType: "unknown",
    });
  });

  it("strips internal prefixes before parsing", () => {
    expect(parseTelegramTarget("telegram:group:-1001234567890:topic:456")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 456,
      chatType: "group",
    });
  });
});

describe("telegram numeric target normalization", () => {
  it.each(numericTelegramTargetNormalizers)(
    "$name keeps numeric chat ids unchanged",
    ({ normalize }) => {
      expect(normalize("-1001234567890")).toBe("-1001234567890");
      expect(normalize("123456789")).toBe("123456789");
    },
  );
});

describe("normalizeTelegramChatId", () => {
  it("rejects username and t.me forms", () => {
    expect(normalizeTelegramChatId("telegram:https://t.me/MyChannel")).toBeUndefined();
    expect(normalizeTelegramChatId("tg:t.me/mychannel")).toBeUndefined();
    expect(normalizeTelegramChatId("@MyChannel")).toBeUndefined();
    expect(normalizeTelegramChatId("MyChannel")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(normalizeTelegramChatId("  ")).toBeUndefined();
  });
});

describe("normalizeTelegramLookupTarget", () => {
  it("normalizes legacy t.me and username targets", () => {
    expect(normalizeTelegramLookupTarget("telegram:https://t.me/MyChannel")).toBe("@MyChannel");
    expect(normalizeTelegramLookupTarget("tg:t.me/mychannel")).toBe("@mychannel");
    expect(normalizeTelegramLookupTarget("@MyChannel")).toBe("@MyChannel");
    expect(normalizeTelegramLookupTarget("MyChannel")).toBe("@MyChannel");
  });

  it("rejects invalid username forms", () => {
    expect(normalizeTelegramLookupTarget("@bad-handle")).toBeUndefined();
    expect(normalizeTelegramLookupTarget("bad-handle")).toBeUndefined();
    expect(normalizeTelegramLookupTarget("ab")).toBeUndefined();
  });
});

describe("isNumericTelegramChatId", () => {
  it("matches numeric telegram chat ids", () => {
    expect(isNumericTelegramChatId("-1001234567890")).toBe(true);
    expect(isNumericTelegramChatId("123456789")).toBe(true);
  });

  it("rejects non-numeric chat ids", () => {
    expect(isNumericTelegramChatId("@mychannel")).toBe(false);
    expect(isNumericTelegramChatId("t.me/mychannel")).toBe(false);
  });
});

describe("telegram group policy", () => {
  it("resolves topic-level requireMention and chat-level tools for topic ids", () => {
    const telegramCfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: {
            "-1001": {
              requireMention: true,
              tools: { allow: ["message.send"] },
              topics: {
                "77": {
                  requireMention: false,
                },
              },
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
    } as any;
    expect(
      resolveTelegramGroupRequireMention({ cfg: telegramCfg, groupId: "-1001:topic:77" }),
    ).toBe(false);
    expect(resolveTelegramGroupToolPolicy({ cfg: telegramCfg, groupId: "-1001:topic:77" })).toEqual(
      {
        allow: ["message.send"],
      },
    );
  });

  it("honors account-scoped topic requireMention overrides", () => {
    const telegramCfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: {
            "-1001": {
              requireMention: true,
              topics: {
                "77": {
                  requireMention: true,
                },
              },
            },
          },
          accounts: {
            work: {
              botToken: "telegram-work",
              groups: {
                "-1001": {
                  topics: {
                    "77": {
                      requireMention: false,
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    expect(
      resolveTelegramGroupRequireMention({
        cfg: telegramCfg,
        accountId: "work",
        groupId: "-1001:topic:77",
      }),
    ).toBe(false);
  });
});

describe("telegram allow-from helpers", () => {
  it("normalizes tg/telegram prefixes", () => {
    const cases = [
      { value: " TG:123 ", expected: "123" },
      { value: "telegram:@someone", expected: "@someone" },
    ] as const;
    for (const testCase of cases) {
      expect(normalizeTelegramAllowFromEntry(testCase.value)).toBe(testCase.expected);
    }
  });

  it("accepts signed numeric IDs", () => {
    const cases = [
      { value: "123456789", expected: true },
      { value: "-1001234567890", expected: true },
      { value: "@someone", expected: false },
      { value: "12 34", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isNumericTelegramUserId(testCase.value)).toBe(testCase.expected);
    }
  });

  it("accepts only positive numeric sender user IDs", () => {
    const cases = [
      { value: "123456789", expected: true },
      { value: "-1001234567890", expected: false },
      { value: "@someone", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isNumericTelegramSenderUserId(testCase.value)).toBe(testCase.expected);
    }
  });
});

describe("telegram target normalization", () => {
  it("normalizes telegram prefixes, group targets, and topic suffixes", () => {
    expect(normalizeTelegramMessagingTarget("telegram:123456")).toBe("telegram:123456");
    expect(normalizeTelegramMessagingTarget("tg:group:-100123")).toBe("telegram:group:-100123");
    expect(normalizeTelegramMessagingTarget("telegram:-100123:topic:99")).toBe(
      "telegram:-100123:topic:99",
    );
  });

  it("returns undefined for invalid telegram recipients", () => {
    expect(normalizeTelegramMessagingTarget("telegram:")).toBeUndefined();
    expect(normalizeTelegramMessagingTarget("   ")).toBeUndefined();
  });

  it("detects valid telegram target identifiers", () => {
    expect(looksLikeTelegramTargetId("telegram:123456")).toBe(true);
    expect(looksLikeTelegramTargetId("tg:group:-100123")).toBe(true);
    expect(looksLikeTelegramTargetId("hello world")).toBe(false);
  });
});

installMaybePersistResolvedTelegramTargetTests({ includeGatewayScopeCases: true });
