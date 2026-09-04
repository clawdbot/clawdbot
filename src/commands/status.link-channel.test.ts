// Status link-channel tests cover channel link status summaries and redaction.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const pluginRegistry = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => pluginRegistry.list,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: () => undefined,
}));

import { resolveLinkChannelContext } from "../status/link-channel.js";

describe("resolveLinkChannelContext", () => {
  it("returns linked context from read-only inspected account state", async () => {
    const account = { configured: true, enabled: true, linked: true };
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
          buildChannelSummary: () => {
            throw new Error("runtime summary must not receive inspection metadata");
          },
        },
      },
    ];

    const result = await resolveLinkChannelContext({} as OpenClawConfig);
    expect(result?.linked).toBe(true);
    expect(result?.authAgeMs).toBeNull();
    expect(result?.account).toBe(account);
  });

  it("preserves link age from runtime summary hooks when an account is resolved", async () => {
    const account = { configured: true, enabled: true, authDir: "/synthetic/auth" };
    const summary = vi.fn(() => ({ linked: true, authAgeMs: 1234 }));
    pluginRegistry.list = [
      {
        id: "quietchat",
        meta: { label: "QuietChat" },
        config: { listAccountIds: () => ["default"], resolveAccount: () => account },
        status: { buildChannelSummary: summary },
      },
    ];

    const result = await resolveLinkChannelContext({});
    expect(result).toMatchObject({ linked: true, authAgeMs: 1234, account });
    expect(summary).toHaveBeenCalledWith(expect.objectContaining({ account }));
  });

  it("reports unexpected account resolution failures", async () => {
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

    await expect(resolveLinkChannelContext({} as OpenClawConfig)).rejects.toThrow("missing secret");
  });
});
