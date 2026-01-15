import { describe, expect, it } from "vitest";

import { resolveChannelConfigWrites } from "./config-writes.js";

describe("resolveChannelConfigWrites", () => {
  it("defaults to allow when unset", () => {
    const cfg = {};
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack" })).toBe(true);
  });

  it("blocks when channel config disables writes", () => {
    const cfg = { channels: { slack: { configWrites: false } } };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack" })).toBe(false);
  });

  it("account override wins over channel default", () => {
    const cfg = {
      channels: {
        slack: {
          configWrites: true,
          accounts: {
            work: { configWrites: false },
          },
        },
      },
    };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(false);
  });

  it("matches account ids case-insensitively", () => {
    const cfg = {
      channels: {
        slack: {
          configWrites: true,
          accounts: {
            Work: { configWrites: false },
          },
        },
      },
    };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(false);
  });
});
