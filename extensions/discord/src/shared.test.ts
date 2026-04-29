import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordPluginBase } from "./shared.js";

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
