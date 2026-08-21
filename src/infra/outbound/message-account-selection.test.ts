import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateExplicitMessageAccountSelection } from "./message-account-selection.js";

describe("validateExplicitMessageAccountSelection", () => {
  const cfg = {} as OpenClawConfig;
  const plugin = {
    id: "feishu",
    config: {
      listAccountIds: () => ["default"],
      defaultAccountId: () => "ops",
      resolveAccount: (_cfg: OpenClawConfig, accountId?: string | null) => ({
        accountId,
        enabled: true,
      }),
    },
  } as unknown as ChannelPlugin;

  it("accepts the plugin-resolved default when it is intentionally unlisted", () => {
    expect(
      validateExplicitMessageAccountSelection({
        cfg,
        channel: "feishu",
        accountId: "OPS",
        plugin,
      }),
    ).toBe("ops");
  });

  it("still rejects a non-default unlisted account", () => {
    expect(() =>
      validateExplicitMessageAccountSelection({
        cfg,
        channel: "feishu",
        accountId: "missing",
        plugin,
      }),
    ).toThrow('Unknown account "missing"');
  });
});

describe("resolveMessageBroadcastAccountPlan (registry-scoped channel plugins)", () => {
  const scopedPlugin = {
    id: "line",
    config: {
      listAccountIds: () => ["ops"],
      resolveAccount: (_cfg: OpenClawConfig, accountId?: string | null) => ({
        accountId,
        enabled: true,
      }),
    },
  } as unknown as ChannelPlugin;
  const scopedCfg = { channels: { line: { enabled: true } } } as unknown as OpenClawConfig;

  it("plans candidates from a channel plugin that is only registry-scoped", async () => {
    const { withPluginRuntimeRegistryScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    const { resolveMessageBroadcastAccountPlan } = await import("./message-account-selection.js");

    const plan = withPluginRuntimeRegistryScope(
      { channels: [{ plugin: scopedPlugin }] } as never,
      () => resolveMessageBroadcastAccountPlan({ cfg: scopedCfg, accountId: "ops" }),
    );
    expect(plan?.candidateChannels).toContain("line");
    expect(plan?.secretChannels).toEqual(["line"]);
  });

  it("does not see the scoped channel outside the scope", async () => {
    const { resolveMessageBroadcastAccountPlan } = await import("./message-account-selection.js");

    const plan = resolveMessageBroadcastAccountPlan({ cfg: scopedCfg, accountId: "ops" });
    expect(plan?.candidateChannels).not.toContain("line");
    expect(plan?.secretChannels).toEqual([]);
  });
});
