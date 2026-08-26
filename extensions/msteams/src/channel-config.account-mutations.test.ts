import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveMSTeamsAccount } from "./accounts.js";
import { msteamsConfigAdapter } from "./channel-config.js";

describe("msteams account config mutations", () => {
  it("disables an explicit default account without disabling sibling accounts", () => {
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          accounts: {
            default: { appId: "default-app", appPassword: "default-secret" },
            support: { appId: "support-app", appPassword: "support-secret" },
          },
        },
      },
    } as OpenClawConfig;

    const updated = msteamsConfigAdapter.setAccountEnabled({
      cfg,
      accountId: "default",
      enabled: false,
    });

    expect(updated.channels?.msteams?.enabled).toBeUndefined();
    expect(updated.channels?.msteams?.accounts?.default?.enabled).toBe(false);
    expect(resolveMSTeamsAccount({ cfg: updated, accountId: "support" }).enabled).toBe(true);
  });

  it("mutates a display-style account through its canonical id", () => {
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          accounts: {
            "Support Bot": { appId: "support-app", appPassword: "support-secret" },
          },
        },
      },
    } as OpenClawConfig;

    const updated = msteamsConfigAdapter.setAccountEnabled({
      cfg,
      accountId: "support-bot",
      enabled: false,
    });

    expect(updated.channels?.msteams?.accounts).toEqual({
      "Support Bot": expect.objectContaining({ enabled: false }),
    });
  });

  it("deletes a display-style account and reselects its default", () => {
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          defaultAccount: "Support Bot",
          accounts: {
            "Support Bot": { appId: "support-app", appPassword: "support-secret" },
            backup: { appId: "backup-app", appPassword: "backup-secret" },
          },
        },
      },
    } as OpenClawConfig;

    const updated = msteamsConfigAdapter.deleteAccount({ cfg, accountId: "support-bot" });

    expect(updated.channels?.msteams?.accounts).toEqual({
      backup: expect.objectContaining({ appId: "backup-app" }),
    });
    expect(updated.channels?.msteams?.defaultAccount).toBe("backup");
    expect(resolveMSTeamsAccount({ cfg: updated }).accountId).toBe("backup");
  });

  it("falls back to a legacy root identity after deleting the last named default", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "legacy-app",
          appPassword: "legacy-secret",
          tenantId: "tenant-id",
          defaultAccount: "support",
          accounts: {
            support: { appId: "explicit-app", appPassword: "explicit-secret" },
          },
        },
      },
    } as OpenClawConfig;

    const updated = msteamsConfigAdapter.deleteAccount({ cfg, accountId: "support" });

    expect(updated.channels?.msteams?.accounts).toBeUndefined();
    expect(updated.channels?.msteams?.defaultAccount).toBe("default");
    expect(resolveMSTeamsAccount({ cfg: updated })).toMatchObject({
      accountId: "default",
      configured: true,
    });
  });
});
