import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getDmHistoryLimitFromSessionKey } from "./pi-embedded-runner/history.js";

describe("getDmHistoryLimitFromSessionKey", () => {
  it("keeps backward compatibility for dm/direct session kinds", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 10 } },
    } as OpenClawConfig;

    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(10);
    expect(getDmHistoryLimitFromSessionKey("telegram:direct:123", config)).toBe(10);
  });

  it("returns historyLimit for channel and group session kinds", () => {
    const config = {
      channels: { discord: { historyLimit: 12, dmHistoryLimit: 5 } },
    } as OpenClawConfig;

    expect(getDmHistoryLimitFromSessionKey("discord:channel:123", config)).toBe(12);
    expect(getDmHistoryLimitFromSessionKey("discord:group:456", config)).toBe(12);
  });

  it("returns undefined for unsupported session kinds", () => {
    const config = {
      channels: { discord: { historyLimit: 12, dmHistoryLimit: 5 } },
    } as OpenClawConfig;

    expect(getDmHistoryLimitFromSessionKey("discord:slash:123", config)).toBeUndefined();
  });
});
