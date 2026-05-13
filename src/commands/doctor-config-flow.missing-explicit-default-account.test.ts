import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectMissingExplicitDefaultAccountWarnings } from "./doctor/shared/default-account-warnings.js";

describe("collectMissingExplicitDefaultAccountWarnings", () => {
  it("warns when multiple named accounts are configured without default selection", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
            work: { botToken: "w" },
          },
        },
      },
    };

    const warnings = collectMissingExplicitDefaultAccountWarnings(cfg);
    expect(warnings).toEqual([
      "- channels.telegram: multiple accounts are configured but no explicit default is set. Set channels.telegram.defaultAccount or add channels.telegram.accounts.default to avoid fallback routing.",
    ]);
  });

  it("does not warn for a single named account without default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            work: { botToken: "w" },
          },
        },
      },
    };

    expect(collectMissingExplicitDefaultAccountWarnings(cfg)).toStrictEqual([]);
  });

  it("does not warn when accounts.default exists", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            default: { botToken: "d" },
            work: { botToken: "w" },
          },
        },
      },
    };

    expect(collectMissingExplicitDefaultAccountWarnings(cfg)).toStrictEqual([]);
  });

  it("does not warn when defaultAccount points to a configured account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: {
            alerts: { botToken: "a" },
            work: { botToken: "w" },
          },
        },
      },
    };

    expect(collectMissingExplicitDefaultAccountWarnings(cfg)).toStrictEqual([]);
  });

  it("normalizes defaultAccount before validating configured account ids", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "Router D",
          accounts: {
            "router-d": { botToken: "r" },
            work: { botToken: "w" },
          },
        },
      },
    };

    expect(collectMissingExplicitDefaultAccountWarnings(cfg)).toStrictEqual([]);
  });

  it("warns when defaultAccount is invalid for configured accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "missing",
          accounts: {
            alerts: { botToken: "a" },
            work: { botToken: "w" },
          },
        },
      },
    };

    const warnings = collectMissingExplicitDefaultAccountWarnings(cfg);
    expect(warnings).toEqual([
      '- channels.telegram: defaultAccount is set to "missing" but does not match configured accounts (alerts, work). Set channels.telegram.defaultAccount to one of these accounts, or add channels.telegram.accounts.default to avoid fallback routing.',
    ]);
  });

  it("warns across channels that support account maps", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
            work: { botToken: "w" },
          },
        },
        slack: {
          accounts: {
            a: { botToken: "x" },
            b: { botToken: "y" },
          },
        },
      },
    };

    const warnings = collectMissingExplicitDefaultAccountWarnings(cfg);
    expect(warnings).toHaveLength(2);
    const warningOutput = warnings.join("\n");
    expect(warningOutput).toContain("channels.telegram");
    expect(warningOutput).toContain("channels.slack");
  });
});
