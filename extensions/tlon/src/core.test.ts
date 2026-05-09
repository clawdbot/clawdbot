import {
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { TlonAuthorizationSchema, TlonConfigSchema } from "./config-schema.js";
import { tlonSetupWizard } from "./setup-surface.js";
import { normalizeShip, resolveTlonOutboundTarget } from "./targets.js";
import { listTlonAccountIds, resolveTlonAccount } from "./types.js";

const tlonTestPlugin = {
  id: "tlon",
  meta: { label: "Tlon" },
  setupWizard: tlonSetupWizard,
  config: {
    listAccountIds: listTlonAccountIds,
    defaultAccountId: () => "default",
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
      resolveTlonAccount(cfg, accountId).dmAllowlist,
    formatAllowFrom: ({
      allowFrom,
    }: {
      cfg: OpenClawConfig;
      allowFrom: Array<string | number> | undefined | null;
    }) => {
      const entries: string[] = [];
      for (const entry of allowFrom ?? []) {
        const normalized = normalizeShip(String(entry));
        if (normalized) {
          entries.push(normalized);
        }
      }
      return entries;
    },
  },
  setup: {
    resolveAccountId: ({ accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
      accountId ?? "default",
  },
};

const tlonConfigure = createPluginSetupWizardConfigure(tlonTestPlugin);
const tlonStatus = createPluginSetupWizardStatus(tlonTestPlugin);

describe("tlon core", () => {
  it("formats dm allowlist entries through the shared hybrid adapter", () => {
    expect(
      tlonTestPlugin.config.formatAllowFrom?.({
        cfg: {} as OpenClawConfig,
        allowFrom: ["zod", " ~nec "],
      }),
    ).toEqual(["~zod", "~nec"]);
  });

  it("returns an empty dm allowlist when the default account is unconfigured", () => {
    expect(
      tlonTestPlugin.config.resolveAllowFrom?.({
        cfg: {} as OpenClawConfig,
        accountId: "default",
      }),
    ).toStrictEqual([]);
  });

  it("resolves dm allowlist from the default account", () => {
    expect(
      tlonTestPlugin.config.resolveAllowFrom?.({
        cfg: {
          channels: {
            tlon: {
              ship: "~sampel-palnet",
              url: "https://urbit.example.com",
              code: "lidlut-tabwed-pillex-ridrup",
              dmAllowlist: ["~zod"],
            },
          },
        } as OpenClawConfig,
        accountId: "default",
      }),
    ).toEqual(["~zod"]);
  });

  it("accepts channelRules with string keys", () => {
    const parsed = TlonAuthorizationSchema.parse({
      channelRules: {
        "chat/~zod/test": {
          mode: "open",
          allowedShips: ["~zod"],
        },
      },
    });

    expect(parsed.channelRules?.["chat/~zod/test"]?.mode).toBe("open");
  });

  it("accepts accounts with string keys", () => {
    const parsed = TlonConfigSchema.parse({
      accounts: {
        primary: {
          ship: "~zod",
          url: "https://example.com",
          code: "code-123",
        },
      },
    });

    expect(parsed.accounts?.primary?.ship).toBe("~zod");
  });

  it("exposes group invite allowlists in channel config schema", () => {
    expect(TlonConfigSchema.parse({ groupInviteAllowlist: ["~zod"] }).groupInviteAllowlist).toEqual(
      ["~zod"],
    );
    expect(
      TlonConfigSchema.parse({
        accounts: { primary: { groupInviteAllowlist: ["~nec"] } },
      }).accounts?.primary?.groupInviteAllowlist,
    ).toEqual(["~nec"]);
  });

  it("configures ship, auth, and discovery settings", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Ship name") {
          return "sampel-palnet";
        }
        if (message === "Ship URL") {
          return "https://urbit.example.com";
        }
        if (message === "Login code") {
          return "lidlut-tabwed-pillex-ridrup";
        }
        if (message === "Group channels (comma-separated)") {
          return "chat/~host-ship/general, chat/~host-ship/support";
        }
        if (message === "DM allowlist (comma-separated ship names)") {
          return "~zod, nec";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Add group channels manually? (optional)") {
          return true;
        }
        if (message === "Restrict DMs with an allowlist?") {
          return true;
        }
        if (message === "Enable auto-discovery of group channels?") {
          return true;
        }
        return false;
      }),
    });

    const result = await runSetupWizardConfigure({
      configure: tlonConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.tlon?.enabled).toBe(true);
    expect(result.cfg.channels?.tlon?.ship).toBe("~sampel-palnet");
    expect(result.cfg.channels?.tlon?.url).toBe("https://urbit.example.com");
    expect(result.cfg.channels?.tlon?.code).toBe("lidlut-tabwed-pillex-ridrup");
    expect(result.cfg.channels?.tlon?.groupChannels).toEqual([
      "chat/~host-ship/general",
      "chat/~host-ship/support",
    ]);
    expect(result.cfg.channels?.tlon?.dmAllowlist).toEqual(["~zod", "~nec"]);
    expect(result.cfg.channels?.tlon?.autoDiscoverChannels).toBe(true);
    expect(result.cfg.channels?.tlon?.network?.dangerouslyAllowPrivateNetwork).toBe(false);
  });

  it("resolves dm targets to normalized ships", () => {
    expect(resolveTlonOutboundTarget("dm/sampel-palnet")).toEqual({
      ok: true,
      to: "~sampel-palnet",
    });
  });

  it("resolves group targets to canonical chat nests", () => {
    expect(resolveTlonOutboundTarget("group:host-ship/general")).toEqual({
      ok: true,
      to: "chat/~host-ship/general",
    });
  });

  it("returns a helpful error for invalid targets", () => {
    const resolved = resolveTlonOutboundTarget("group:bad-target");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected invalid target");
    }
    expect(resolved.error.message).toMatch(/invalid tlon target/i);
  });

  it("lists named accounts and the implicit default account", () => {
    const cfg = {
      channels: {
        tlon: {
          ship: "~zod",
          accounts: {
            Work: { ship: "~bus" },
            alerts: { ship: "~nec" },
          },
        },
      },
    } as OpenClawConfig;

    expect(listTlonAccountIds(cfg)).toEqual(["alerts", "default", "work"]);
  });

  it("merges named account config over channel defaults", () => {
    const resolved = resolveTlonAccount(
      {
        channels: {
          tlon: {
            name: "Base",
            ship: "~zod",
            url: "https://urbit.example.com",
            code: "base-code",
            dmAllowlist: ["~nec"],
            groupInviteAllowlist: ["~bus"],
            defaultAuthorizedShips: ["~marzod"],
            accounts: {
              Work: {
                name: "Work",
                code: "work-code",
                dmAllowlist: ["~rovnys"],
              },
            },
          },
        },
      } as OpenClawConfig,
      "work",
    );

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.ship).toBe("~zod");
    expect(resolved.url).toBe("https://urbit.example.com");
    expect(resolved.code).toBe("work-code");
    expect(resolved.dmAllowlist).toEqual(["~rovnys"]);
    expect(resolved.groupInviteAllowlist).toEqual(["~bus"]);
    expect(resolved.defaultAuthorizedShips).toEqual(["~marzod"]);
    expect(resolved.configured).toBe(true);
  });

  it("keeps the default account on channel-level config only", () => {
    const resolved = resolveTlonAccount(
      {
        channels: {
          tlon: {
            ship: "~zod",
            url: "https://urbit.example.com",
            code: "base-code",
            accounts: {
              default: {
                ship: "~ignored",
                code: "ignored-code",
              },
            },
          },
        },
      } as OpenClawConfig,
      "default",
    );

    expect(resolved.ship).toBe("~zod");
    expect(resolved.code).toBe("base-code");
  });

  it("setup status labels the selected account", async () => {
    const status = await tlonStatus({
      cfg: {
        channels: {
          tlon: {
            ship: "~zod",
            url: "https://urbit.example.com",
            code: "base-code",
            accounts: {
              work: {},
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: { tlon: "work" },
    });

    expect(status.configured).toBe(true);
    expect(status.statusLines).toEqual(["Tlon (work): configured"]);
  });
});
