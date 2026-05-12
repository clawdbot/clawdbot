import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectMissingDefaultAccountBindingWarnings,
  collectMissingExplicitDefaultAccountWarnings,
} from "./doctor/shared/default-account-warnings.js";

describe("doctor missing default account binding warning", () => {
  it("warns when named accounts have no valid account-scoped bindings", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            alerts: {},
            work: {},
          },
        },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
    } as OpenClawConfig);

    expect(warnings).toEqual([
      '- channels.telegram: accounts.default is missing and no valid account-scoped binding exists for configured accounts (alerts, work). Channel-only bindings (no accountId) match only default. Add bindings[].match.accountId for one of these accounts (or "*"), or add channels.telegram.accounts.default.',
    ]);
  });

  it("warns when multiple accounts have no explicit default", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          accounts: {
            alerts: {},
            work: {},
          },
        },
      },
    } as OpenClawConfig);

    expect(warnings).toEqual([
      "- channels.telegram: multiple accounts are configured but no explicit default is set. Set channels.telegram.defaultAccount or add channels.telegram.accounts.default to avoid fallback routing.",
    ]);
  });

  it("warns when defaultAccount does not match configured accounts", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          defaultAccount: "missing",
          accounts: {
            alerts: {},
            work: {},
          },
        },
      },
    } as OpenClawConfig);

    expect(warnings).toEqual([
      '- channels.telegram: defaultAccount is set to "missing" but does not match configured accounts (alerts, work). Set channels.telegram.defaultAccount to one of these accounts, or add channels.telegram.accounts.default to avoid fallback routing.',
    ]);
  });
});
