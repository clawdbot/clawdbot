import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createChannelDmPolicy } from "./channel-dm-policy.js";

describe("createChannelDmPolicy", () => {
  it("resolves root and account keys from the effective account", () => {
    const dmPolicy = createChannelDmPolicy({
      label: "Test",
      channel: "telegram",
      resolveAccount: (cfg, accountId) => ({
        accountId: accountId ?? "default",
        config: cfg.channels?.telegram ?? {},
      }),
      promptAllowFrom: async ({ cfg }) => cfg,
    });
    const cfg: OpenClawConfig = {};

    expect(dmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.telegram.dmPolicy",
      allowFromKey: "channels.telegram.allowFrom",
    });
    expect(dmPolicy.resolveConfigKeys?.(cfg, "work")).toEqual({
      policyKey: "channels.telegram.accounts.work.dmPolicy",
      allowFromKey: "channels.telegram.accounts.work.allowFrom",
    });
  });

  it("adds the wildcard through the default account patch path", () => {
    const dmPolicy = createChannelDmPolicy({
      label: "Test",
      channel: "telegram",
      resolveAccount: (cfg) => ({
        accountId: "default",
        config: cfg.channels?.telegram ?? {},
      }),
      promptAllowFrom: async ({ cfg }) => cfg,
    });

    expect(
      dmPolicy.setPolicy(
        { channels: { telegram: { allowFrom: ["123"] } } } as OpenClawConfig,
        "open",
      ).channels?.telegram,
    ).toMatchObject({ enabled: true, dmPolicy: "open", allowFrom: ["123", "*"] });
  });

  it("supports channel-specific key, allow-from, patch, and apply hooks", () => {
    const applyPatch = vi.fn(({ cfg }: { cfg: OpenClawConfig }) => cfg);
    const dmPolicy = createChannelDmPolicy({
      label: "Nested",
      channel: "matrix",
      policyPath: "dm.policy",
      allowFromPath: "dm.allowFrom",
      resolveAccount: () => ({
        accountId: "default",
        config: { dmPolicy: "allowlist" as const, allowFrom: ["alice"] },
      }),
      resolveAllowFrom: ({ policy, account }) =>
        policy === "disabled" ? [] : [...(account.config.allowFrom ?? [])],
      buildPatch: ({ policy, allowFrom }) => ({ dm: { policy, allowFrom } }),
      applyPatch,
      promptAllowFrom: async ({ cfg }) => cfg,
    });
    const cfg: OpenClawConfig = {};

    expect(dmPolicy.policyKey).toBe("channels.matrix.dm.policy");
    expect(dmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(dmPolicy.setPolicy(cfg, "disabled")).toBe(cfg);
    expect(applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        patch: { dm: { policy: "disabled", allowFrom: [] } },
      }),
    );
  });
});
