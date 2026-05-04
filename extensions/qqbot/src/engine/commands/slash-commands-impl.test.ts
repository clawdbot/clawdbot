import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { resolveQQBotCommandsAllowFrom, resolveSlashCommandAuth } from "./slash-command-auth.js";
import { getWrittenQQBotConfig, installCommandRuntime } from "./slash-command-test-support.js";
import { getFrameworkCommands, matchSlashCommand } from "./slash-commands-impl.js";
import { SlashCommandRegistry, type SlashCommandContext } from "./slash-commands.js";

function createStreamingContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    type: "c2c",
    senderId: "UNTRUSTED_OPENID",
    messageId: "msg-1",
    eventTimestamp: "2026-01-01T00:00:00.000Z",
    receivedAt: 1,
    rawContent: "/bot-streaming on",
    args: "",
    accountId: "default",
    appId: "app",
    accountConfig: { allowFrom: ["*"], streaming: false },
    commandAuthorized: false,
    queueSnapshot: {
      totalPending: 0,
      activeUsers: 0,
      maxConcurrentUsers: 1,
      senderPending: 0,
    },
    ...overrides,
  };
}

describe("QQBot framework slash commands", () => {
  it("exposes private-only admin commands with private-chat metadata", () => {
    const commands = getFrameworkCommands();
    const names = commands.map((command) => command.name);

    expect(names).toEqual(
      expect.arrayContaining(["bot-approve", "bot-clear-storage", "bot-logs", "bot-streaming"]),
    );
    for (const commandName of ["bot-approve", "bot-clear-storage", "bot-logs", "bot-streaming"]) {
      expect(commands.find((command) => command.name === commandName)?.c2cOnly).toBe(true);
    }
  });

  it("preserves private-only auth metadata for framework registration", () => {
    const registry = new SlashCommandRegistry();
    registry.register({
      name: "private-admin",
      description: "private admin command",
      requireAuth: true,
      c2cOnly: true,
      handler: () => "ok",
    });
    registry.register({
      name: "shared-admin",
      description: "shared admin command",
      requireAuth: true,
      handler: () => "ok",
    });

    const commands = registry.getFrameworkCommands();

    expect(commands.map((command) => command.name)).toEqual(["private-admin", "shared-admin"]);
    expect(commands.find((command) => command.name === "private-admin")?.c2cOnly).toBe(true);
    expect(commands.find((command) => command.name === "shared-admin")?.c2cOnly).toBeUndefined();
  });

  it("routes bot-streaming through the auth-gated framework registry", () => {
    expect(getFrameworkCommands().map((command) => command.name)).toContain("bot-streaming");
  });

  it("does not write streaming config when the sender is not command-authorized", async () => {
    const writes: OpenClawConfig[] = [];
    installCommandRuntime(
      {
        channels: {
          qqbot: {
            allowFrom: ["*"],
            streaming: false,
          },
        },
      },
      writes,
    );

    const result = await matchSlashCommand(createStreamingContext());

    expect(result).toContain("权限不足");
    expect(writes).toHaveLength(0);
  });

  it("does not write streaming config when allowFrom mixes wildcard with another sender", async () => {
    const writes: OpenClawConfig[] = [];
    const allowFrom = ["*", "TRUSTED_OPENID"];
    installCommandRuntime(
      {
        channels: {
          qqbot: {
            allowFrom,
            streaming: false,
          },
        },
      },
      writes,
    );

    const commandAuthorized = resolveSlashCommandAuth({
      senderId: "UNTRUSTED_OPENID",
      isGroup: false,
      allowFrom,
    });
    const result = await matchSlashCommand(
      createStreamingContext({
        accountConfig: { allowFrom, streaming: false },
        commandAuthorized,
      }),
    );

    expect(commandAuthorized).toBe(false);
    expect(result).toContain("权限不足");
    expect(writes).toHaveLength(0);
  });

  it("writes streaming config when commands.allowFrom grants the sender in open DM configs", async () => {
    const writes: OpenClawConfig[] = [];
    installCommandRuntime(
      {
        commands: {
          allowFrom: {
            qqbot: ["TRUSTED_OPENID"],
          },
        },
        channels: {
          qqbot: {
            allowFrom: ["*"],
            streaming: false,
          },
        },
      },
      writes,
    );

    const commandAuthorized = resolveSlashCommandAuth({
      senderId: "TRUSTED_OPENID",
      isGroup: false,
      allowFrom: ["*"],
      commandsAllowFrom: resolveQQBotCommandsAllowFrom({
        commands: {
          allowFrom: {
            qqbot: ["TRUSTED_OPENID"],
          },
        },
      }),
    });
    const result = await matchSlashCommand(
      createStreamingContext({
        senderId: "TRUSTED_OPENID",
        accountConfig: { allowFrom: ["*"], streaming: false },
        commandAuthorized,
      }),
    );

    const qqbot = getWrittenQQBotConfig(writes[0]);
    expect(commandAuthorized).toBe(true);
    expect(result).toContain("已开启");
    expect(writes).toHaveLength(1);
    expect(qqbot?.streaming).toBe(true);
  });

  it("writes streaming config when the sender is command-authorized", async () => {
    const writes: OpenClawConfig[] = [];
    const allowFrom = ["*", "TRUSTED_OPENID"];
    installCommandRuntime(
      {
        channels: {
          qqbot: {
            allowFrom,
            streaming: false,
            accounts: {
              default: {
                allowFrom,
                streaming: false,
              },
            },
          },
        },
      },
      writes,
    );

    const commandAuthorized = resolveSlashCommandAuth({
      senderId: "TRUSTED_OPENID",
      isGroup: false,
      allowFrom,
    });
    const result = await matchSlashCommand(
      createStreamingContext({
        senderId: "TRUSTED_OPENID",
        accountConfig: { allowFrom, streaming: false },
        commandAuthorized,
      }),
    );

    const qqbot = getWrittenQQBotConfig(writes[0]);
    expect(commandAuthorized).toBe(true);
    expect(result).toContain("已开启");
    expect(writes).toHaveLength(1);
    expect(qqbot?.streaming).toBe(true);
    expect(qqbot?.accounts?.default?.streaming).toBe(true);
  });
});
