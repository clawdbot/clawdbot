import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { runSecurityAudit } from "./audit.js";
import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { slackPlugin } from "../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";

describe("security audit", () => {
  it("includes an attack surface summary (info)", async () => {
    const cfg: MoltbotConfig = {
      channels: { whatsapp: { groupPolicy: "open" }, telegram: { groupPolicy: "allowlist" } },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
      hooks: { enabled: true },
      browser: { enabled: true },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "summary.attack_surface", severity: "info" }),
      ]),
    );
  });

  it("flags non-loopback bind without auth as critical", async () => {
    const cfg: MoltbotConfig = {
      gateway: {
        bind: "lan",
        auth: {},
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(
      res.findings.some((f) => f.checkId === "gateway.bind_no_auth" && f.severity === "critical"),
    ).toBe(true);
  });

  it("warns when loopback control UI lacks trusted proxies", async () => {
    const cfg: MoltbotConfig = {
      gateway: {
        bind: "loopback",
        controlUi: { enabled: true },
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "gateway.trusted_proxies_missing",
          severity: "warn",
        }),
      ]),
    );
  });

  it("flags loopback control UI without auth as critical", async () => {
    const cfg: MoltbotConfig = {
      gateway: {
        bind: "loopback",
        controlUi: { enabled: true },
        auth: {},
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "gateway.loopback_no_auth",
          severity: "critical",
        }),
      ]),
    );
  });

  it("flags logging.redactSensitive=off", async () => {
    const cfg: MoltbotConfig = {
      logging: { redactSensitive: "off" },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "logging.redact_off", severity: "warn" }),
      ]),
    );
  });

  it("treats Windows ACL-only perms as secure", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-win-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "moltbot.json");
    await fs.writeFile(configPath, "{}\n", "utf-8");

    const user = "DESKTOP-TEST\\Tester";
    const execIcacls = async (_cmd: string, args: string[]) => ({
      stdout: `${args[0]} NT AUTHORITY\\SYSTEM:(F)\n ${user}:(F)\n`,
      stderr: "",
    });

    const res = await runSecurityAudit({
      config: {},
      includeFilesystem: true,
      includeChannelSecurity: false,
      stateDir,
      configPath,
      platform: "win32",
      env: { ...process.env, USERNAME: "Tester", USERDOMAIN: "DESKTOP-TEST" },
      execIcacls,
    });

    const forbidden = new Set([
      "fs.state_dir.perms_world_writable",
      "fs.state_dir.perms_group_writable",
      "fs.state_dir.perms_readable",
      "fs.config.perms_writable",
      "fs.config.perms_world_readable",
      "fs.config.perms_group_readable",
    ]);
    for (const id of forbidden) {
      expect(res.findings.some((f) => f.checkId === id)).toBe(false);
    }
  });

  it("flags Windows ACLs when Users can read the state dir", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-win-open-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "moltbot.json");
    await fs.writeFile(configPath, "{}\n", "utf-8");

    const user = "DESKTOP-TEST\\Tester";
    const execIcacls = async (_cmd: string, args: string[]) => {
      const target = args[0];
      if (target === stateDir) {
        return {
          stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Users:(RX)\n ${user}:(F)\n`,
          stderr: "",
        };
      }
      return {
        stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n ${user}:(F)\n`,
        stderr: "",
      };
    };

    const res = await runSecurityAudit({
      config: {},
      includeFilesystem: true,
      includeChannelSecurity: false,
      stateDir,
      configPath,
      platform: "win32",
      env: { ...process.env, USERNAME: "Tester", USERDOMAIN: "DESKTOP-TEST" },
      execIcacls,
    });

    expect(
      res.findings.some(
        (f) => f.checkId === "fs.state_dir.perms_readable" && f.severity === "warn",
      ),
    ).toBe(true);
  });

  it("warns when small models are paired with web/browser tools", async () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
      tools: {
        web: {
          search: { enabled: true },
          fetch: { enabled: true },
        },
      },
      browser: { enabled: true },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    const finding = res.findings.find((f) => f.checkId === "models.small_params");
    expect(finding?.severity).toBe("critical");
    expect(finding?.detail).toContain("mistral-8b");
    expect(finding?.detail).toContain("web_search");
    expect(finding?.detail).toContain("web_fetch");
    expect(finding?.detail).toContain("browser");
  });

  it("treats small models as safe when sandbox is on and web tools are disabled", async () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { model: { primary: "ollama/mistral-8b" }, sandbox: { mode: "all" } } },
      tools: {
        web: {
          search: { enabled: false },
          fetch: { enabled: false },
        },
      },
      browser: { enabled: false },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    const finding = res.findings.find((f) => f.checkId === "models.small_params");
    expect(finding?.severity).toBe("info");
    expect(finding?.detail).toContain("mistral-8b");
    expect(finding?.detail).toContain("sandbox=all");
  });

  it("flags tools.elevated allowFrom wildcard as critical", async () => {
    const cfg: MoltbotConfig = {
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["*"] },
        },
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "tools.elevated.allowFrom.whatsapp.wildcard",
          severity: "critical",
        }),
      ]),
    );
  });

  it("warns when remote CDP uses HTTP", async () => {
    const cfg: MoltbotConfig = {
      browser: {
        profiles: {
          remote: { cdpUrl: "http://example.com:9222", color: "#0066CC" },
        },
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "browser.remote_cdp_http", severity: "warn" }),
      ]),
    );
  });

  it("warns when control UI allows insecure auth", async () => {
    const cfg: MoltbotConfig = {
      gateway: {
        controlUi: { allowInsecureAuth: true },
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "gateway.control_ui.insecure_auth",
          severity: "critical",
        }),
      ]),
    );
  });

  it("warns when control UI device auth is disabled", async () => {
    const cfg: MoltbotConfig = {
      gateway: {
        controlUi: { dangerouslyDisableDeviceAuth: true },
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "gateway.control_ui.device_auth_disabled",
          severity: "critical",
        }),
      ]),
    );
  });

  it("warns when multiple DM senders share the main session", async () => {
    const cfg: MoltbotConfig = { session: { dmScope: "main" } };
    const plugins: ChannelPlugin[] = [
      {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "Test",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: () => ({
            policy: "allowlist",
            allowFrom: ["user-a", "user-b"],
            policyPath: "channels.whatsapp.dmPolicy",
            allowFromPath: "channels.whatsapp.",
            approveHint: "approve",
          }),
        },
      },
    ];

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: true,
      plugins,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "channels.whatsapp.dm.scope_main_multiuser",
          severity: "warn",
        }),
      ]),
    );
  });

  it("flags Discord native commands without a guild user allowlist", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-discord-"));
    process.env.CLAWDBOT_STATE_DIR = tmp;
    await fs.mkdir(path.join(tmp, "credentials"), { recursive: true, mode: 0o700 });
    try {
      const cfg: MoltbotConfig = {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  general: { allow: true },
                },
              },
            },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [discordPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.discord.commands.native.no_allowlists",
            severity: "warn",
          }),
        ]),
      );
    } finally {
      if (prevStateDir == null) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = prevStateDir;
    }
  });

  it("does not flag Discord slash commands when dm.allowFrom includes a Discord snowflake id", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), "moltbot-security-audit-discord-allowfrom-snowflake-"),
    );
    process.env.CLAWDBOT_STATE_DIR = tmp;
    await fs.mkdir(path.join(tmp, "credentials"), { recursive: true, mode: 0o700 });
    try {
      const cfg: MoltbotConfig = {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            dm: { allowFrom: ["387380367612706819"] },
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  general: { allow: true },
                },
              },
            },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [discordPlugin],
      });

      expect(res.findings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.discord.commands.native.no_allowlists",
          }),
        ]),
      );
    } finally {
      if (prevStateDir == null) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = prevStateDir;
    }
  });

  it("flags Discord slash commands when access-group enforcement is disabled and no users allowlist exists", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-discord-open-"));
    process.env.CLAWDBOT_STATE_DIR = tmp;
    await fs.mkdir(path.join(tmp, "credentials"), { recursive: true, mode: 0o700 });
    try {
      const cfg: MoltbotConfig = {
        commands: { useAccessGroups: false },
        channels: {
          discord: {
            enabled: true,
            token: "t",
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  general: { allow: true },
                },
              },
            },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [discordPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.discord.commands.native.unrestricted",
            severity: "critical",
          }),
        ]),
      );
    } finally {
      if (prevStateDir == null) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = prevStateDir;
    }
  });

  it("flags Slack slash commands without a channel users allowlist", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-slack-"));
    process.env.CLAWDBOT_STATE_DIR = tmp;
    await fs.mkdir(path.join(tmp, "credentials"), { recursive: true, mode: 0o700 });
    try {
      const cfg: MoltbotConfig = {
        channels: {
          slack: {
            enabled: true,
            botToken: "xoxb-test",
            appToken: "xapp-test",
            groupPolicy: "open",
            slashCommand: { enabled: true },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [slackPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.slack.commands.slash.no_allowlists",
            severity: "warn",
          }),
        ]),
      );
    } finally {
      if (prevStateDir == null) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = prevStateDir;
    }
  });

  it("flags Slack slash commands when access-group enforcement is disabled", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-slack-open-"));
    process.env.CLAWDBOT_STATE_DIR = tmp;
    await fs.mkdir(path.join(tmp, "credentials"), { recursive: true, mode: 0o700 });
    try {
      const cfg: MoltbotConfig = {
        commands: { useAccessGroups: false },
        channels: {
          slack: {
            enabled: true,
            botToken: "xoxb-test",
            appToken: "xapp-test",
            groupPolicy: "open",
            slashCommand: { enabled: true },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [slackPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.slack.commands.slash.useAccessGroups_off",
            severity: "critical",
          }),
        ]),
      );
    } finally {
      if (prevStateDir == null) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = prevStateDir;
    }
  });

  it("flags Telegram group commands without a sender allowlist", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-telegram-"));
    process.env.CLAWDBOT_STATE_DIR = tmp;
    await fs.mkdir(path.join(tmp, "credentials"), { recursive: true, mode: 0o700 });
    try {
      const cfg: MoltbotConfig = {
        channels: {
          telegram: {
            enabled: true,
            botToken: "t",
            groupPolicy: "allowlist",
            groups: { "-100123": {} },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [telegramPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.telegram.groups.allowFrom.missing",
            severity: "critical",
          }),
        ]),
      );
    } finally {
      if (prevStateDir == null) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = prevStateDir;
    }
  });

  it("adds a warning when deep probe fails", async () => {
    const cfg: MoltbotConfig = { gateway: { mode: "local" } };

    const res = await runSecurityAudit({
      config: cfg,
      deep: true,
      deepTimeoutMs: 50,
      includeFilesystem: false,
      includeChannelSecurity: false,
      probeGatewayFn: async () => ({
        ok: false,
        url: "ws://127.0.0.1:18789",
        connectLatencyMs: null,
        error: "connect failed",
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }),
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "gateway.probe_failed", severity: "warn" }),
      ]),
    );
  });

  it("adds a warning when deep probe throws", async () => {
    const cfg: MoltbotConfig = { gateway: { mode: "local" } };

    const res = await runSecurityAudit({
      config: cfg,
      deep: true,
      deepTimeoutMs: 50,
      includeFilesystem: false,
      includeChannelSecurity: false,
      probeGatewayFn: async () => {
        throw new Error("probe boom");
      },
    });

    expect(res.deep?.gateway.ok).toBe(false);
    expect(res.deep?.gateway.error).toContain("probe boom");
    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "gateway.probe_failed", severity: "warn" }),
      ]),
    );
  });

  it("warns on legacy model configuration", async () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-3.5-turbo" } } },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "models.legacy", severity: "warn" }),
      ]),
    );
  });

  it("warns on weak model tiers", async () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5" } } },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "models.weak_tier", severity: "warn" }),
      ]),
    );
  });

  it("warns when hooks token looks short", async () => {
    const cfg: MoltbotConfig = {
      hooks: { enabled: true, token: "short" },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "hooks.token_too_short", severity: "warn" }),
      ]),
    );
  });

  it("warns when hooks token reuses the gateway env token", async () => {
    const prevToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
    process.env.CLAWDBOT_GATEWAY_TOKEN = "shared-gateway-token-1234567890";
    const cfg: MoltbotConfig = {
      hooks: { enabled: true, token: "shared-gateway-token-1234567890" },
    };

    try {
      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkId: "hooks.token_reuse_gateway_token", severity: "warn" }),
        ]),
      );
    } finally {
      if (prevToken === undefined) delete process.env.CLAWDBOT_GATEWAY_TOKEN;
      else process.env.CLAWDBOT_GATEWAY_TOKEN = prevToken;
    }
  });

  it("warns when state/config look like a synced folder", async () => {
    const cfg: MoltbotConfig = {};

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
      stateDir: "/Users/test/Dropbox/.clawdbot",
      configPath: "/Users/test/Dropbox/.clawdbot/moltbot.json",
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "fs.synced_dir", severity: "warn" }),
      ]),
    );
  });

  it("flags group/world-readable config include files", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });

    const includePath = path.join(stateDir, "extra.json5");
    await fs.writeFile(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    if (isWindows) {
      // Grant "Everyone" write access to trigger the perms_writable check on Windows
      const { execSync } = await import("node:child_process");
      execSync(`icacls "${includePath}" /grant Everyone:W`, { stdio: "ignore" });
    } else {
      await fs.chmod(includePath, 0o644);
    }

    const configPath = path.join(stateDir, "moltbot.json");
    await fs.writeFile(configPath, `{ "$include": "./extra.json5" }\n`, "utf-8");
    await fs.chmod(configPath, 0o600);

    try {
      const cfg: MoltbotConfig = { logging: { redactSensitive: "off" } };
      const user = "DESKTOP-TEST\\Tester";
      const execIcacls = isWindows
        ? async (_cmd: string, args: string[]) => {
            const target = args[0];
            if (target === includePath) {
              return {
                stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Users:(W)\n ${user}:(F)\n`,
                stderr: "",
              };
            }
            return {
              stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n ${user}:(F)\n`,
              stderr: "",
            };
          }
        : undefined;
      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: true,
        includeChannelSecurity: false,
        stateDir,
        configPath,
        platform: isWindows ? "win32" : undefined,
        env: isWindows
          ? { ...process.env, USERNAME: "Tester", USERDOMAIN: "DESKTOP-TEST" }
          : undefined,
        execIcacls,
      });

      const expectedCheckId = isWindows
        ? "fs.config_include.perms_writable"
        : "fs.config_include.perms_world_readable";

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkId: expectedCheckId, severity: "critical" }),
        ]),
      );
    } finally {
      // Clean up temp directory with world-writable file
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("flags extensions without plugins.allow", async () => {
    const prevDiscordToken = process.env.DISCORD_BOT_TOKEN;
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const prevSlackBotToken = process.env.SLACK_BOT_TOKEN;
    const prevSlackAppToken = process.env.SLACK_APP_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(path.join(stateDir, "extensions", "some-plugin"), {
      recursive: true,
      mode: 0o700,
    });

    try {
      const cfg: MoltbotConfig = {};
      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: true,
        includeChannelSecurity: false,
        stateDir,
        configPath: path.join(stateDir, "moltbot.json"),
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkId: "plugins.extensions_no_allowlist", severity: "warn" }),
        ]),
      );
    } finally {
      if (prevDiscordToken == null) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = prevDiscordToken;
      if (prevTelegramToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      if (prevSlackBotToken == null) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevSlackBotToken;
      if (prevSlackAppToken == null) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = prevSlackAppToken;
    }
  });

  it("flags unallowlisted extensions as critical when native skill commands are exposed", async () => {
    const prevDiscordToken = process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-security-audit-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(path.join(stateDir, "extensions", "some-plugin"), {
      recursive: true,
      mode: 0o700,
    });

    try {
      const cfg: MoltbotConfig = {
        channels: {
          discord: { enabled: true, token: "t" },
        },
      };
      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: true,
        includeChannelSecurity: false,
        stateDir,
        configPath: path.join(stateDir, "moltbot.json"),
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "plugins.extensions_no_allowlist",
            severity: "critical",
          }),
        ]),
      );
    } finally {
      if (prevDiscordToken == null) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = prevDiscordToken;
    }
  });

  it("flags open groupPolicy when tools.elevated is enabled", async () => {
    const cfg: MoltbotConfig = {
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
      channels: { whatsapp: { groupPolicy: "open" } },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "security.exposure.open_groups_with_elevated",
          severity: "critical",
        }),
      ]),
    );
  });

  describe("maybeProbeGateway auth selection", () => {
    const originalEnvToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
    const originalEnvPassword = process.env.CLAWDBOT_GATEWAY_PASSWORD;

    beforeEach(() => {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
      delete process.env.CLAWDBOT_GATEWAY_PASSWORD;
    });

    afterEach(() => {
      if (originalEnvToken == null) {
        delete process.env.CLAWDBOT_GATEWAY_TOKEN;
      } else {
        process.env.CLAWDBOT_GATEWAY_TOKEN = originalEnvToken;
      }
      if (originalEnvPassword == null) {
        delete process.env.CLAWDBOT_GATEWAY_PASSWORD;
      } else {
        process.env.CLAWDBOT_GATEWAY_PASSWORD = originalEnvPassword;
      }
    });

    it("uses local auth when gateway.mode is local", async () => {
      let capturedAuth: { token?: string; password?: string } | undefined;
      const cfg: MoltbotConfig = {
        gateway: {
          mode: "local",
          auth: { token: "local-token-abc123" },
        },
      };

      await runSecurityAudit({
        config: cfg,
        deep: true,
        deepTimeoutMs: 50,
        includeFilesystem: false,
        includeChannelSecurity: false,
        probeGatewayFn: async (opts) => {
          capturedAuth = opts.auth;
          return {
            ok: true,
            url: opts.url,
            connectLatencyMs: 10,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          };
        },
      });

      expect(capturedAuth?.token).toBe("local-token-abc123");
    });

    it("prefers env token over local config token", async () => {
      process.env.CLAWDBOT_GATEWAY_TOKEN = "env-token";
      let capturedAuth: { token?: string; password?: string } | undefined;
      const cfg: MoltbotConfig = {
        gateway: {
          mode: "local",
          auth: { token: "local-token" },
        },
      };

      await runSecurityAudit({
        config: cfg,
        deep: true,
        deepTimeoutMs: 50,
        includeFilesystem: false,
        includeChannelSecurity: false,
        probeGatewayFn: async (opts) => {
          capturedAuth = opts.auth;
          return {
            ok: true,
            url: opts.url,
            connectLatencyMs: 10,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          };
        },
      });

      expect(capturedAuth?.token).toBe("env-token");
    });

    it("uses local auth when gateway.mode is undefined (default)", async () => {
      let capturedAuth: { token?: string; password?: string } | undefined;
      const cfg: MoltbotConfig = {
        gateway: {
          auth: { token: "default-local-token" },
        },
      };

      await runSecurityAudit({
        config: cfg,
        deep: true,
        deepTimeoutMs: 50,
        includeFilesystem: false,
        includeChannelSecurity: false,
        probeGatewayFn: async (opts) => {
          capturedAuth = opts.auth;
          return {
            ok: true,
            url: opts.url,
            connectLatencyMs: 10,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          };
        },
      });

      expect(capturedAuth?.token).toBe("default-local-token");
    });

    it("uses remote auth when gateway.mode is remote with URL", async () => {
      let capturedAuth: { token?: string; password?: string } | undefined;
      const cfg: MoltbotConfig = {
        gateway: {
          mode: "remote",
          auth: { token: "local-token-should-not-use" },
          remote: {
            url: "ws://remote.example.com:18789",
            token: "remote-token-xyz789",
          },
        },
      };

      await runSecurityAudit({
        config: cfg,
        deep: true,
        deepTimeoutMs: 50,
        includeFilesystem: false,
        includeChannelSecurity: false,
        probeGatewayFn: async (opts) => {
          capturedAuth = opts.auth;
          return {
            ok: true,
            url: opts.url,
            connectLatencyMs: 10,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          };
        },
      });

      expect(capturedAuth?.token).toBe("remote-token-xyz789");
    });

    it("ignores env token when gateway.mode is remote", async () => {
      process.env.CLAWDBOT_GATEWAY_TOKEN = "env-token";
      let capturedAuth: { token?: string; password?: string } | undefined;
      const cfg: MoltbotConfig = {
        gateway: {
          mode: "remote",
          auth: { token: "local-token-should-not-use" },
          remote: {
            url: "ws://remote.example.com:18789",
            token: "remote-token",
          },
        },
      };

      await runSecurityAudit({
        config: cfg,
        deep: true,
        deepTimeoutMs: 50,
        includeFilesystem: false,
        includeChannelSecurity: false,
        probeGatewayFn: async (opts) => {
          capturedAuth = opts.auth;
          return {
            ok: true,
            url: opts.url,
            connectLatencyMs: 10,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          };
        },
      });

      expect(capturedAuth?.token).toBe("remote-token");
    });

    it("uses remote password when env is unset", async () => {
      let capturedAuth: { token?: string; password?: string } | undefined;
      const cfg: MoltbotConfig = {
        gateway: {
          mode: "remote",
          remote: {
            url: "ws://remote.example.com:18789",
            password: "remote-pass",
          },
        },
      };

      await runSecurityAudit({
        config: cfg,
        deep: true,
        deepTimeoutMs: 50,
        includeFilesystem: false,
        includeChannelSecurity: false,
        probeGatewayFn: async (opts) => {
          capturedAuth = opts.auth;
          return {
            ok: true,
            url: opts.url,
            connectLatencyMs: 10,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          };
        },
      });

      expect(capturedAuth?.password).toBe("remote-pass");
    });

    it("prefers env password over remote password", async () => {
      process.env.CLAWDBOT_GATEWAY_PASSWORD = "env-pass";
      let capturedAuth: { token?: string; password?: string } | undefined;
      const cfg: MoltbotConfig = {
        gateway: {
          mode: "remote",
          remote: {
            url: "ws://remote.example.com:18789",
            password: "remote-pass",
          },
        },
      };

      await runSecurityAudit({
        config: cfg,
        deep: true,
        deepTimeoutMs: 50,
        includeFilesystem: false,
        includeChannelSecurity: false,
        probeGatewayFn: async (opts) => {
          capturedAuth = opts.auth;
          return {
            ok: true,
            url: opts.url,
            connectLatencyMs: 10,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          };
        },
      });

      expect(capturedAuth?.password).toBe("env-pass");
    });

    it("falls back to local auth when gateway.mode is remote but URL is missing", async () => {
      let capturedAuth: { token?: string; password?: string } | undefined;
      const cfg: MoltbotConfig = {
        gateway: {
          mode: "remote",
          auth: { token: "fallback-local-token" },
          remote: {
            token: "remote-token-should-not-use",
          },
        },
      };

      await runSecurityAudit({
        config: cfg,
        deep: true,
        deepTimeoutMs: 50,
        includeFilesystem: false,
        includeChannelSecurity: false,
        probeGatewayFn: async (opts) => {
          capturedAuth = opts.auth;
          return {
            ok: true,
            url: opts.url,
            connectLatencyMs: 10,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          };
        },
      });

      expect(capturedAuth?.token).toBe("fallback-local-token");
    });
  });
});
