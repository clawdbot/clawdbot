import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const pluginRegistry = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => pluginRegistry.list,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: () => undefined,
}));

import { resolveLinkChannelContext } from "./status.link-channel.js";

describe("resolveLinkChannelContext", () => {
  it("returns linked context from read-only inspected account state", async () => {
    const account = { configured: true, enabled: true };
    pluginRegistry.list = [
      {
        id: "quietchat",
        meta: { label: "QuietChat" },
        config: {
          listAccountIds: () => ["default"],
          inspectAccount: () => account,
          resolveAccount: () => {
            throw new Error("should not be called in read-only mode");
          },
        },
        status: {
          buildChannelSummary: () => ({ linked: true, authAgeMs: 1234 }),
        },
      },
    ];

    const result = await resolveLinkChannelContext({} as OpenClawConfig);
    expect(result?.linked).toBe(true);
    expect(result?.authAgeMs).toBe(1234);
    expect(result?.account).toBe(account);
  });

  it("degrades safely when account resolution throws", async () => {
    pluginRegistry.list = [
      {
        id: "quietchat",
        meta: { label: "QuietChat" },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => {
            throw new Error("missing secret");
          },
        },
      },
    ];

    const result = await resolveLinkChannelContext({} as OpenClawConfig);
    expect(result).toBeNull();
  });
});
