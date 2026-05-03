import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordPluginBase, discordConfigAdapter } from "./shared.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createDiscordPluginBase", () => {
  it("owns Discord native command name overrides", () => {
    const plugin = createDiscordPluginBase({ setup: {} as never });

    expect(
      plugin.commands?.resolveNativeCommandName?.({
        commandKey: "tts",
        defaultName: "tts",
      }),
    ).toBe("voice");
    expect(
      plugin.commands?.resolveNativeCommandName?.({
        commandKey: "status",
        defaultName: "status",
      }),
    ).toBe("status");
  });

  it("exposes security checks on the setup surface", () => {
    const plugin = createDiscordPluginBase({ setup: {} as never });

    expect(plugin.security?.resolveDmPolicy).toBeTypeOf("function");
    expect(plugin.security?.collectWarnings).toBeTypeOf("function");
    expect(plugin.security?.collectAuditFindings).toBeTypeOf("function");
  });

  it("hydrates announce delivery targets from stored session routing", () => {
    const plugin = createDiscordPluginBase({ setup: {} as never });

    expect(plugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });

  it("reports duplicate-token accounts as disabled to gateway startup", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "same-token");
    const plugin = createDiscordPluginBase({ setup: {} as never });
    const cfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              token: "same-token",
            },
          },
        },
      },
    };

    const defaultAccount = plugin.config.resolveAccount(cfg, "default");
    const workAccount = plugin.config.resolveAccount(cfg, "work");

    expect(plugin.config.isEnabled?.(defaultAccount, cfg)).toBe(false);
    expect(plugin.config.disabledReason?.(defaultAccount, cfg)).toBe(
      'duplicate bot token; using account "work"',
    );
    expect(plugin.config.isEnabled?.(workAccount, cfg)).toBe(true);
  });
});

describe("discordConfigAdapter", () => {
  it("resolves top-level allowFrom before legacy dm.allowFrom", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            default: {
              allowFrom: ["123"],
              dm: { allowFrom: ["456"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(discordConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual(["123"]);
  });

  it("falls back to legacy dm.allowFrom", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            default: {
              dm: { allowFrom: ["456"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(discordConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual(["456"]);
  });

  it("prefers account legacy dm.allowFrom over inherited root allowFrom", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: ["root"],
          accounts: {
            work: {
              dm: { allowFrom: ["account-legacy"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(discordConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "work" })).toEqual([
      "account-legacy",
    ]);
  });

  it("coerces numeric allowFrom entries at the config boundary", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            default: {
              allowFrom: [123456789],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(discordConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "123456789",
    ]);
  });

  it("keeps read-only accessors from resolving token SecretRefs", () => {
    const cfg = {
      secrets: {
        providers: {
          discord_token: {
            source: "file",
            path: "/tmp/openclaw-missing-discord-token",
            mode: "singleValue",
          },
        },
      },
      channels: {
        discord: {
          token: { source: "file", provider: "discord_token", id: "value" },
          allowFrom: ["1128540374256849009"],
          defaultTo: "1498959610751750304",
        },
      },
    } as OpenClawConfig;

    expect(discordConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "1128540374256849009",
    ]);
    expect(discordConfigAdapter.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe(
      "1498959610751750304",
    );
  });
});
