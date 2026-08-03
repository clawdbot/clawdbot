// Config helper tests cover channel plugin config merge and selection helpers.
import { describe, expect, it } from "vitest";
import { clearAccountEntryFields } from "./config-helpers.js";

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
