// Config helper tests cover channel plugin config merge and selection helpers.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAccountEntryFields, setAccountEnabledInConfigSection } from "./config-helpers.js";

describe("clearAccountEntryFields", () => {
  it("clears configured values and removes empty account entries", () => {
    const result = clearAccountEntryFields({
      accounts: {
        default: {
          botToken: "abc123",
        },
      },
      accountId: "default",
      fields: ["botToken"],
    });

    expect(result).toEqual({
      nextAccounts: undefined,
      changed: true,
      cleared: true,
    });
  });

  it("treats empty string values as not configured by default", () => {
    const result = clearAccountEntryFields({
      accounts: {
        default: {
          botToken: "   ",
        },
      },
      accountId: "default",
      fields: ["botToken"],
    });

    expect(result).toEqual({
      nextAccounts: undefined,
      changed: true,
      cleared: false,
    });
  });

  it("can mark cleared when fields are present even if values are empty", () => {
    const result = clearAccountEntryFields({
      accounts: {
        default: {
          tokenFile: "",
        },
      },
      accountId: "default",
      fields: ["tokenFile"],
      markClearedOnFieldPresence: true,
    });

    expect(result).toEqual({
      nextAccounts: undefined,
      changed: true,
      cleared: true,
    });
  });

  it("keeps other account fields intact", () => {
    const result = clearAccountEntryFields({
      accounts: {
        default: {
          botToken: "abc123",
          name: "Primary",
        },
        backup: {
          botToken: "keep",
        },
      },
      accountId: "default",
      fields: ["botToken"],
    });

    expect(result).toEqual({
      nextAccounts: {
        default: {
          name: "Primary",
        },
        backup: {
          botToken: "keep",
        },
      },
      changed: true,
      cleared: true,
    });
  });

  it("returns unchanged when account entry is missing", () => {
    const result = clearAccountEntryFields({
      accounts: {
        default: {
          botToken: "abc123",
        },
      },
      accountId: "other",
      fields: ["botToken"],
    });

    expect(result).toEqual({
      nextAccounts: {
        default: {
          botToken: "abc123",
        },
      },
      changed: false,
      cleared: false,
    });
  });
});

// #120332 round 58 (P1): section reads and writes resolve the AUTHORED key through canonical
// channel identity. Validation admits any declared spelling; an exact-key write would split
// the section across two spellings and an exact-key read would ignore accepted settings.
describe("section keys resolve through canonical channel identity", () => {
  it("writes through the authored variant spelling of the section key", () => {
    const cfg: OpenClawConfig = {
      channels: { qqbot: { accounts: { work: { enabled: true } } } },
    } as OpenClawConfig;

    const next = setAccountEnabledInConfigSection({
      cfg,
      sectionKey: "QQBot",
      accountId: "work",
      enabled: false,
    });

    const channels = next.channels as Record<string, unknown>;
    expect(Object.keys(channels)).toEqual(["qqbot"]);
    const section = channels.qqbot as { accounts: Record<string, { enabled?: boolean }> };
    expect(section.accounts.work?.enabled).toBe(false);
  });

  it("skips a non-record exact section and writes the record-shaped authored variant", () => {
    const cfg: OpenClawConfig = {
      channels: {
        QQBot: { accounts: { work: { enabled: true } } },
        qqbot: "stale-marker",
      } as never,
    } as OpenClawConfig;

    const next = setAccountEnabledInConfigSection({
      cfg,
      sectionKey: "qqbot",
      accountId: "work",
      enabled: false,
    });

    const channels = next.channels as Record<string, unknown>;
    expect(channels.qqbot).toBe("stale-marker");
    const section = channels.QQBot as { accounts: Record<string, { enabled?: boolean }> };
    expect(section.accounts.work?.enabled).toBe(false);
  });

  it("replaces a lone non-record exact section instead of spreading it", () => {
    const cfg: OpenClawConfig = {
      channels: { qqbot: "stale-marker" } as never,
    } as OpenClawConfig;

    const next = setAccountEnabledInConfigSection({
      cfg,
      sectionKey: "qqbot",
      accountId: "work",
      enabled: true,
    });

    const channels = next.channels as Record<string, unknown>;
    expect(channels.qqbot).toEqual({ accounts: { work: { enabled: true } } });
  });
});
