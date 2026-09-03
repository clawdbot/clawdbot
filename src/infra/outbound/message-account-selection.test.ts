import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { validateExplicitMessageAccountSelection } from "./message-account-selection.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
  vi.restoreAllMocks();
});

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

  it("rejects only an unavailable active account before resolving its credentials", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId: "feishu:ops",
        state: "unavailable",
        paths: ["channels.feishu.accounts.ops.appSecret"],
        refKeys: ["env:default:MISSING_FEISHU_SECRET"],
        reason: "secret reference was not found",
      },
    ]);
    const resolveAccount = vi.spyOn(plugin.config, "resolveAccount");

    expect(() =>
      validateExplicitMessageAccountSelection({
        cfg,
        channel: "feishu",
        accountId: "OPS",
        plugin,
      }),
    ).toThrowError(expect.objectContaining({ code: "SECRET_SURFACE_UNAVAILABLE" }));
    expect(resolveAccount).not.toHaveBeenCalled();

    expect(
      validateExplicitMessageAccountSelection({
        cfg,
        channel: "feishu",
        accountId: "OPS",
        plugin,
        checkResolvedAccount: false,
      }),
    ).toBe("ops");
    expect(
      validateExplicitMessageAccountSelection({
        cfg,
        channel: "feishu",
        accountId: "default",
        plugin,
      }),
    ).toBe("default");
  });
});

describe("resolveMessageBroadcastAccountPlan (registry-scoped channel plugins)", () => {
  const scopedPlugin = {
    id: "scopex",
    config: {
      listAccountIds: () => ["ops"],
      resolveAccount: (_cfg: OpenClawConfig, accountId?: string | null) => ({
        accountId,
        enabled: true,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ messageId: "scopex-message" }),
    },
  } as unknown as ChannelPlugin;
  const unavailablePlugin: ChannelPlugin = {
    ...scopedPlugin,
    id: "scopex-unavailable",
    outbound: undefined,
  };
  const scopedCfg = {
    channels: {
      scopex: { enabled: true },
      "scopex-unavailable": { enabled: true },
    },
  } as unknown as OpenClawConfig;

  it("plans candidates from a channel plugin that is only registry-scoped", async () => {
    const { withPluginRuntimeRegistryScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    const { resolveMessageBroadcastAccountPlan } = await import("./message-account-selection.js");

    const plan = withPluginRuntimeRegistryScope(
      { channels: [{ plugin: scopedPlugin }, { plugin: unavailablePlugin }] } as never,
      () => resolveMessageBroadcastAccountPlan({ cfg: scopedCfg, accountId: "ops" }),
    );
    expect(plan?.candidateChannels).toEqual(["scopex"]);
    expect(plan?.secretChannels).toEqual(["scopex"]);
  });

  it("does not see the scoped channel outside the scope", async () => {
    const { resolveMessageBroadcastAccountPlan } = await import("./message-account-selection.js");

    const plan = resolveMessageBroadcastAccountPlan({ cfg: scopedCfg, accountId: "ops" });
    expect(plan?.candidateChannels).not.toContain("scopex");
    expect(plan?.secretChannels).toEqual([]);
  });
});
