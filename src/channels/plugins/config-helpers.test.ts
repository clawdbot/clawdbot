// Config helper tests cover channel plugin config merge and selection helpers.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAccountEntryFields, clearAccountFieldsFromConfigSection } from "./config-helpers.js";

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

describe("clearAccountFieldsFromConfigSection", () => {
  function clear(cfg: OpenClawConfig, accountId = "default", markClearedOnFieldPresence = false) {
    const original = structuredClone(cfg);
    const result = clearAccountFieldsFromConfigSection({
      cfg,
      sectionKey: "sample",
      accountId,
      fields: ["token", "secret"],
      markClearedOnFieldPresence,
    });
    expect(cfg).toEqual(original);
    return result;
  }

  it.each(["token", "   ", { source: "env", provider: "default", id: "SAMPLE_TOKEN" }])(
    "clears the entire root field group for truthy value %j",
    (token) => {
      const cfg: OpenClawConfig = {
        channels: {
          sample: { token, secret: "", accounts: {}, name: "Keep" },
          other: { enabled: false },
        },
      };
      expect(clear(cfg)).toEqual({
        nextConfig: {
          channels: { sample: { accounts: {}, name: "Keep" }, other: { enabled: false } },
        },
        changed: true,
        cleared: true,
      });
    },
  );

  it.each([false, true])(
    "preserves nested field-presence reporting with mode %s",
    (markClearedOnFieldPresence) => {
      const sibling = { token: "keep" };
      const cfg: OpenClawConfig = {
        channels: {
          sample: { accounts: { primary: { token: "   ", secret: "", name: "Keep" }, sibling } },
        },
      };
      expect(clear(cfg, "primary", markClearedOnFieldPresence)).toEqual({
        nextConfig: { channels: { sample: { accounts: { primary: { name: "Keep" }, sibling } } } },
        changed: true,
        cleared: markClearedOnFieldPresence,
      });
    },
  );

  it("normalizes an empty nested account id without clearing root fields", () => {
    const cfg: OpenClawConfig = {
      channels: { sample: { token: "root", accounts: { default: { token: "nested" } } } },
    };
    expect(clear(cfg, "")).toEqual({
      nextConfig: { channels: { sample: { token: "root" } } },
      changed: true,
      cleared: true,
    });
  });

  it.each([
    {},
    { channels: {} },
    { channels: { sample: { accounts: {} } } },
    { channels: { sample: { token: "", secret: "" } } },
  ])("returns original config without pruning a no-op %j", (cfg) => {
    const result = clear(cfg);
    expect(result).toEqual({ nextConfig: cfg, changed: false, cleared: false });
    expect(result.nextConfig).toBe(cfg);
  });

  it("prunes changed empty account, channel, and channels objects", () => {
    expect(clear({ channels: { sample: { accounts: { default: { token: "remove" } } } } })).toEqual(
      { nextConfig: {}, changed: true, cleared: true },
    );
  });
});
