import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getHistoryLimitFromSessionKey } from "./history.js";

describe("getHistoryLimitFromSessionKey", () => {
  it("matches channel history limits across canonical provider aliases", () => {
    expect(
      getHistoryLimitFromSessionKey("agent:main:z-ai:channel:general", {
        channels: {
          "z.ai": {
            historyLimit: 17,
          },
        },
      }),
    ).toBe(17);
  });

  it("returns undefined when sessionKey or config is undefined", () => {
    expect(getHistoryLimitFromSessionKey(undefined, {})).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("telegram:dm:123", undefined)).toBeUndefined();
  });

  it("returns dmHistoryLimit for direct message sessions", () => {
    const config = {
      channels: {
        telegram: { dmHistoryLimit: 15 },
        whatsapp: { dmHistoryLimit: 20 },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(15);
    expect(getHistoryLimitFromSessionKey("whatsapp:dm:123", config)).toBe(20);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:123", config)).toBe(15);
  });

  it("keeps backward compatibility for dm and direct session kinds", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 10 } },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(10);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:123", config)).toBe(10);
    expect(getHistoryLimitFromSessionKey("telegram:direct:123", config)).toBe(10);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:direct:123", config)).toBe(10);
  });

  it("strips numeric thread and topic suffixes from direct message session keys", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 10, dms: { "123": { historyLimit: 7 } } } },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:123:thread:999", config)).toBe(7);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:123:topic:555", config)).toBe(7);
    expect(getHistoryLimitFromSessionKey("telegram:dm:123:thread:999", config)).toBe(7);
  });

  it("keeps non-numeric thread markers in direct message ids", () => {
    const config = {
      channels: {
        telegram: { dms: { "user:thread:abc": { historyLimit: 9 } } },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:user:thread:abc", config)).toBe(9);
  });

  it("uses per-DM overrides before provider defaults", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 15,
          dms: {
            "123": { historyLimit: 5 },
            "456": {},
            "789": { historyLimit: 0 },
          },
        },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(5);
    expect(getHistoryLimitFromSessionKey("telegram:dm:456", config)).toBe(15);
    expect(getHistoryLimitFromSessionKey("telegram:dm:789", config)).toBe(0);
    expect(getHistoryLimitFromSessionKey("telegram:dm:other", config)).toBe(15);
  });

  it("returns per-DM overrides for agent-prefixed keys and colon-containing ids", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 20,
          dms: { "789": { historyLimit: 3 } },
        },
        msteams: {
          dmHistoryLimit: 10,
          dms: { "user@example.com": { historyLimit: 7 } },
        },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:789", config)).toBe(3);
    expect(getHistoryLimitFromSessionKey("msteams:dm:user@example.com", config)).toBe(7);
  });

  it("returns historyLimit for channel and group sessions", () => {
    const config = {
      channels: {
        slack: { historyLimit: 10, dmHistoryLimit: 15 },
        discord: { historyLimit: 8 },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:beta:slack:channel:c1", config)).toBe(10);
    expect(getHistoryLimitFromSessionKey("discord:channel:123456", config)).toBe(8);
    expect(getHistoryLimitFromSessionKey("discord:group:123", config)).toBe(8);
  });

  it("returns undefined for unsupported session kinds, unknown providers, and missing limits", () => {
    const config = {
      channels: {
        telegram: { historyLimit: 10 },
        discord: { dmHistoryLimit: 10 },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:slash:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("unknown:dm:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("discord:channel:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBeUndefined();
  });

  it("handles supported provider ids for DM and channel history limits", () => {
    const providers = [
      "telegram",
      "whatsapp",
      "discord",
      "slack",
      "signal",
      "imessage",
      "msteams",
      "nextcloud-talk",
    ] as const;

    for (const provider of providers) {
      const config = {
        channels: { [provider]: { dmHistoryLimit: 5, historyLimit: 12 } },
      } as OpenClawConfig;

      expect(getHistoryLimitFromSessionKey(`${provider}:dm:123`, config)).toBe(5);
      expect(getHistoryLimitFromSessionKey(`${provider}:channel:123`, config)).toBe(12);
      expect(getHistoryLimitFromSessionKey(`agent:main:${provider}:channel:456`, config)).toBe(12);
    }
  });
});
