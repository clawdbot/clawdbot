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
    expect(warnings).toStrictEqual([
      '- channels.telegram: accounts.default is missing and no valid account-scoped binding exists for configured accounts (alerts, work). Channel-only bindings (no accountId) match only default. Add bindings[].match.accountId for one of these accounts (or "*"), or add channels.telegram.accounts.default.',
    ]);
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
    expect(warnings).toStrictEqual([
      '- channels.telegram: accounts.default is missing and account bindings only cover a subset of configured accounts. Uncovered accounts: work. Add bindings[].match.accountId for uncovered accounts (or "*"), or add channels.telegram.accounts.default.',
    ]);
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
