import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultChannelAccountContext } from "./channel-account-context.js";

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: vi.fn(async () => null),
}));

describe("resolveDefaultChannelAccountContext", () => {
  it("uses enabled/configured defaults when hooks are missing", async () => {
    const account = { token: "x" };
    const plugin = {
      id: "demo",
      config: {
        listAccountIds: () => ["acc-1"],
        resolveAccount: () => account,
      },
    } as unknown as ChannelPlugin;

    const result = await resolveDefaultChannelAccountContext(plugin, {} as OpenClawConfig);

    expect(result.accountIds).toEqual(["acc-1"]);
    expect(result.defaultAccountId).toBe("acc-1");
    expect(result.account).toBe(account);
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it("uses plugin enable/configure hooks", async () => {
    const account = { enabled: false };
    const isEnabled = vi.fn(() => false);
    const isConfigured = vi.fn(async () => false);
    const plugin = {
      id: "demo",
      config: {
        listAccountIds: () => ["acc-2"],
        resolveAccount: () => account,
        isEnabled,
        isConfigured,
      },
    } as unknown as ChannelPlugin;

    const result = await resolveDefaultChannelAccountContext(plugin, {} as OpenClawConfig);

    expect(isEnabled).toHaveBeenCalledWith(account, {});
    expect(isConfigured).toHaveBeenCalledWith(account, {});
    expect(result.enabled).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it("keeps strict mode fail-closed and degrades read_only mode when resolveAccount throws", async () => {
    const plugin = {
      id: "demo",
      config: {
        listAccountIds: () => ["acc-err"],
        resolveAccount: () => {
          throw new Error("missing secret");
        },
      },
    } as unknown as ChannelPlugin;

    await expect(resolveDefaultChannelAccountContext(plugin, {} as OpenClawConfig)).rejects.toThrow(
      /missing secret/i,
    );

    const result = await resolveDefaultChannelAccountContext(plugin, {} as OpenClawConfig, {
      mode: "read_only",
      commandName: "status",
    });

    expect(result.enabled).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.diagnostics.some((entry) => entry.includes("failed to resolve account"))).toBe(
      true,
    );
  });

  it("prefers inspectAccount in read_only mode", async () => {
    const inspectAccount = vi.fn(() => ({ configured: true, enabled: true }));
    const resolveAccount = vi.fn(() => ({ configured: false, enabled: false }));
    const plugin = {
      id: "demo",
      config: {
        listAccountIds: () => ["acc-1"],
        inspectAccount,
        resolveAccount,
      },
    } as unknown as ChannelPlugin;

    const result = await resolveDefaultChannelAccountContext(plugin, {} as OpenClawConfig, {
      mode: "read_only",
    });

    expect(inspectAccount).toHaveBeenCalled();
    expect(resolveAccount).not.toHaveBeenCalled();
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.degraded).toBe(true);
  });
});
