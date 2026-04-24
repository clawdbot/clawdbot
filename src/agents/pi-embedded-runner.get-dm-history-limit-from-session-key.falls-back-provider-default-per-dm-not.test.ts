import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getDmHistoryLimitFromSessionKey } from "./pi-embedded-runner/history.js";

describe("getDmHistoryLimitFromSessionKey", () => {
  it("falls back to provider default when per-DM not set", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 15,
          dms: { "456": { historyLimit: 5 } },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(15);
  });
  it("returns per-DM override for agent-prefixed keys", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 20,
          dms: { "789": { historyLimit: 3 } },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("agent:main:telegram:dm:789", config)).toBe(3);
  });
  it("handles userId with colons (e.g., email)", () => {
    const config = {
      channels: {
        msteams: {
          dmHistoryLimit: 10,
          dms: { "user@example.com": { historyLimit: 7 } },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("msteams:dm:user@example.com", config)).toBe(7);
  });
  it("returns undefined when per-DM historyLimit is not set", () => {
    const config = {
      channels: {
        telegram: {
          dms: { "123": {} },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBeUndefined();
  });
  it("returns 0 when per-DM historyLimit is explicitly 0 (unlimited)", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 15,
          dms: { "123": { historyLimit: 0 } },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(0);
  });
});
