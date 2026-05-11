import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  getWrittenQQBotConfig,
  installCommandRuntime,
} from "../../engine/commands/slash-command-test-support.js";
import { ensurePlatformAdapter } from "../bootstrap.js";
import { registerQQBotFrameworkCommands } from "./framework-registration.js";

function createConfig(): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        appId: "app",
        allowFrom: ["TRUSTED_OPENID"],
        streaming: false,
        accounts: {
          default: {
            allowFrom: ["TRUSTED_OPENID"],
            streaming: false,
          },
        },
      },
    },
  };
}

function registerCommands(): OpenClawPluginCommandDefinition[] {
  ensurePlatformAdapter();
  const commands: OpenClawPluginCommandDefinition[] = [];
  const api = {
    logger: {},
    registerCommand: (command: OpenClawPluginCommandDefinition) => {
      commands.push(command);
    },
  } as unknown as OpenClawPluginApi;

  registerQQBotFrameworkCommands(api);
  return commands;
}

function findCommand(
  commands: OpenClawPluginCommandDefinition[],
  name: string,
): OpenClawPluginCommandDefinition {
  const command = commands.find((entry) => entry.name === name);
  if (!command) {
    throw new Error(`expected QQBot command ${name}`);
  }
  return command;
}

function createCommandContext(
  config: OpenClawConfig,
  from: string | undefined,
): PluginCommandContext {
  return {
    senderId: "TRUSTED_OPENID",
    channel: "qqbot",
    isAuthorizedSender: true,
    args: "on",
    commandBody: "/bot-streaming on",
    config,
    from,
    requestConversationBinding: async () => undefined,
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  } as unknown as PluginCommandContext;
}

describe("registerQQBotFrameworkCommands", () => {
  it("registers bot-streaming as an auth-gated framework command", () => {
    const command = findCommand(registerCommands(), "bot-streaming");

    expect(command.requireAuth).toBe(true);
    expect(command.channels).toEqual(["qqbot"]);
  });

  it("preserves the private-chat guard for bot-streaming on generic framework calls", async () => {
    const config = createConfig();
    const writes: OpenClawConfig[] = [];
    installCommandRuntime(config, writes);
    const command = findCommand(registerCommands(), "bot-streaming");

    const missingFromResult = await command.handler(createCommandContext(config, undefined));
    const nonQQBotResult = await command.handler(createCommandContext(config, "generic:dm:user"));
    const groupResult = await command.handler(
      createCommandContext(config, "qqbot:group:GROUP_OPENID"),
    );

    expect(missingFromResult).toEqual({ text: "💡 请在私聊中使用此指令" });
    expect(nonQQBotResult).toEqual({ text: "💡 请在私聊中使用此指令" });
    expect(groupResult).toEqual({ text: "💡 请在私聊中使用此指令" });
    expect(writes).toHaveLength(0);
  });

  it("allows bot-streaming on explicit QQBot private-chat framework calls", async () => {
    const config = createConfig();
    const writes: OpenClawConfig[] = [];
    installCommandRuntime(config, writes);
    const command = findCommand(registerCommands(), "bot-streaming");

    const result = await command.handler(createCommandContext(config, "qqbot:c2c:TRUSTED_OPENID"));

    const qqbot = getWrittenQQBotConfig(writes[0]);
    expect(result).toEqual({
      text: "✅ 流式消息已开启\n\nAI 的回复将以流式形式逐步显示（仅私聊生效）。",
    });
    expect(writes).toHaveLength(1);
    expect(qqbot?.streaming).toBe(true);
    expect(qqbot?.accounts?.default?.streaming).toBe(true);
  });
});
