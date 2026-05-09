import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  listAccountIds,
  resolveDefaultAccountId,
  resolveAccountBase,
} from "./resolve.js";

describe("engine/config/resolve", () => {
  it("returns empty list when no accounts configured", () => {
    expect(listAccountIds({})).toStrictEqual([]);
  });

  it("returns default when top-level appId is set", () => {
    const cfg = {
      channels: {
        qqbot: { appId: "123456" },
      },
    };
    expect(listAccountIds(cfg)).toEqual([DEFAULT_ACCOUNT_ID]);
  });

  it("lists named accounts", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: { appId: "654321" },
            bot3: { appId: "111222" },
          },
        },
      },
    };
    const ids = listAccountIds(cfg);
    expect(ids).toContain("bot2");
    expect(ids).toContain("bot3");
  });

  it("resolves default account id to 'default' when top-level appId exists", () => {
    const cfg = {
      channels: {
        qqbot: { appId: "123456" },
      },
    };
    expect(resolveDefaultAccountId(cfg)).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("honors configured defaultAccount", () => {
    const cfg = {
      channels: {
        qqbot: {
          defaultAccount: "bot2",
          accounts: {
            bot2: { appId: "654321" },
          },
        },
      },
    };
    expect(resolveDefaultAccountId(cfg)).toBe("bot2");
  });

  it("falls back to first named account when no default configured", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            mybot: { appId: "999999" },
          },
        },
      },
    };
    expect(resolveDefaultAccountId(cfg)).toBe("mybot");
  });

  it("resolves base account info for default account", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          name: "Test Bot",
          systemPrompt: "You are helpful.",
          markdownSupport: true,
        },
      },
    };
    const base = resolveAccountBase(cfg, DEFAULT_ACCOUNT_ID);
    expect(base.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(base.appId).toBe("123456");
    expect(base.name).toBe("Test Bot");
    expect(base.systemPrompt).toBe("You are helpful.");
    expect(base.markdownSupport).toBe(true);
    expect(base.enabled).toBe(true);
  });

  it("resolves base account info for named account", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: {
              appId: "654321",
              name: "Bot Two",
              enabled: false,
            },
          },
        },
      },
    };
    const base = resolveAccountBase(cfg, "bot2");
    expect(base.accountId).toBe("bot2");
    expect(base.appId).toBe("654321");
    expect(base.name).toBe("Bot Two");
    expect(base.enabled).toBe(false);
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg = {
      channels: {
        qqbot: {
          defaultAccount: "bot2",
          accounts: {
            bot2: { appId: "654321" },
          },
        },
      },
    };
    const base = resolveAccountBase(cfg);
    expect(base.accountId).toBe("bot2");
    expect(base.appId).toBe("654321");
  });

  it("preserves audioFormatPolicy on the config object", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          audioFormatPolicy: {
            sttDirectFormats: [".wav"],
            uploadDirectFormats: [".mp3"],
            transcodeEnabled: false,
          },
        },
      },
    };
    const base = resolveAccountBase(cfg, DEFAULT_ACCOUNT_ID);
    expect(base.config.audioFormatPolicy).toEqual({
      sttDirectFormats: [".wav"],
      uploadDirectFormats: [".mp3"],
      transcodeEnabled: false,
    });
  });
});
