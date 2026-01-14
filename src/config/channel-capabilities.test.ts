import { describe, expect, it } from "vitest";
import { resolveChannelCapabilities } from "./channel-capabilities.js";
import type { ClawdbotConfig } from "./config.js";

describe("resolveChannelCapabilities", () => {
  it("returns undefined for missing inputs", () => {
    expect(resolveChannelCapabilities({})).toBeUndefined();
    expect(
      resolveChannelCapabilities({ cfg: {} as ClawdbotConfig }),
    ).toBeUndefined();
    expect(
      resolveChannelCapabilities({ cfg: {} as ClawdbotConfig, channel: "" }),
    ).toBeUndefined();
  });

  it("normalizes and prefers per-account capabilities", () => {
    const cfg = {
      channels: {
        telegram: {
          capabilities: [" inlineButtons ", ""],
          accounts: {
            default: {
              capabilities: [" perAccount ", "  "],
            },
          },
        },
      },
    } satisfies Partial<ClawdbotConfig>;

    expect(
      resolveChannelCapabilities({
        cfg: cfg as ClawdbotConfig,
        channel: "telegram",
        accountId: "default",
      }),
    ).toEqual(["perAccount"]);
  });

  it("falls back to provider capabilities when account capabilities are missing", () => {
    const cfg = {
      channels: {
        telegram: {
          capabilities: ["inlineButtons"],
          accounts: {
            default: {},
          },
        },
      },
    } satisfies Partial<ClawdbotConfig>;

    expect(
      resolveChannelCapabilities({
        cfg: cfg as ClawdbotConfig,
        channel: "telegram",
        accountId: "default",
      }),
    ).toEqual(["inlineButtons"]);
  });

  it("matches account keys case-insensitively", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            Family: { capabilities: ["threads"] },
          },
        },
      },
    } satisfies Partial<ClawdbotConfig>;

    expect(
      resolveChannelCapabilities({
        cfg: cfg as ClawdbotConfig,
        channel: "slack",
        accountId: "family",
      }),
    ).toEqual(["threads"]);
  });

  it("supports msteams capabilities", () => {
    const cfg = {
      channels: { msteams: { capabilities: [" polls ", ""] } },
    } satisfies Partial<ClawdbotConfig>;

    expect(
      resolveChannelCapabilities({
        cfg: cfg as ClawdbotConfig,
        channel: "msteams",
      }),
    ).toEqual(["polls"]);
  });
});
