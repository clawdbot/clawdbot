import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectMissingDefaultAccountBindingWarnings } from "./doctor/shared/default-account-warnings.js";

describe("collectMissingDefaultAccountBindingWarnings", () => {
  it("warns when named accounts exist without default and no valid binding exists", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
            work: { botToken: "w" },
          },
        },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
    };

    const warnings = collectMissingDefaultAccountBindingWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.telegram");
    expect(warnings[0]).toContain("alerts, work");
  });

  it("does not warn when an explicit account binding exists", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
          },
        },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "alerts" } }],
    };

    expect(collectMissingDefaultAccountBindingWarnings(cfg)).toStrictEqual([]);
  });

  it("warns when bindings cover only a subset of configured accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
            work: { botToken: "w" },
          },
        },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "alerts" } }],
    };

    const warnings = collectMissingDefaultAccountBindingWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("subset");
    expect(warnings[0]).toContain("Uncovered accounts: work");
  });

  it("does not warn when wildcard account binding exists", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
          },
        },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "*" } }],
    };

    expect(collectMissingDefaultAccountBindingWarnings(cfg)).toStrictEqual([]);
  });

  it("does not warn when default account is present", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            default: { botToken: "d" },
            alerts: { botToken: "a" },
          },
        },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
    };

    expect(collectMissingDefaultAccountBindingWarnings(cfg)).toStrictEqual([]);
  });
});
