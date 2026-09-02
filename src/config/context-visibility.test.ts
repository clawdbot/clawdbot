// Covers config-controlled context visibility decisions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import {
  resolveChannelContextVisibilityMode,
  resolveDefaultContextVisibility,
} from "./context-visibility.js";

describe("resolveDefaultContextVisibility", () => {
  it("reads channels.defaults.contextVisibility", () => {
    expect(
      resolveDefaultContextVisibility({
        channels: {
          defaults: {
            contextVisibility: "allowlist_quote",
          },
        },
      }),
    ).toBe("allowlist_quote");
  });
});

describe("resolveChannelContextVisibilityMode", () => {
  it("prefers explicitly provided mode", () => {
    expect(
      resolveChannelContextVisibilityMode({
        cfg: {},
        channel: "slack",
        configuredContextVisibility: "allowlist",
      }),
    ).toBe("allowlist");
  });

  it("falls back to account mode then channel mode then defaults", () => {
    const cfg = {
      channels: {
        defaults: {
          contextVisibility: "allowlist_quote",
        },
        slack: {
          contextVisibility: "allowlist",
          accounts: {
            work: {
              contextVisibility: "all",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    expect(
      resolveChannelContextVisibilityMode({
        cfg,
        channel: "slack",
        accountId: "work",
      }),
    ).toBe("all");
    expect(
      resolveChannelContextVisibilityMode({
        cfg,
        channel: "slack",
        accountId: "missing",
      }),
    ).toBe("allowlist");
    expect(
      resolveChannelContextVisibilityMode({
        cfg: {
          channels: {
            defaults: { contextVisibility: "allowlist_quote" },
          },
        } satisfies OpenClawConfig,
        channel: "signal",
      }),
    ).toBe("allowlist_quote");
  });

  it("defaults to all when unset", () => {
    expect(
      resolveChannelContextVisibilityMode({
        cfg: {},
        channel: "telegram",
      }),
    ).toBe("all");
  });
});
