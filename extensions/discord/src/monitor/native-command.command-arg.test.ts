import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordCommandArgFallbackButton,
  type DispatchDiscordCommandInteraction,
} from "./native-command-ui.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type CommandArgContext = Parameters<typeof createDiscordCommandArgFallbackButton>[0]["ctx"];
type CommandArgButton = ReturnType<typeof createDiscordCommandArgFallbackButton>;
type CommandArgInteraction = Parameters<CommandArgButton["run"]>[0];
type CommandArgData = Parameters<CommandArgButton["run"]>[1];

function createCommandDefinition(): ChatCommandDefinition {
  return {
    key: "think",
    nativeName: "think",
    description: "Set thinking level",
    textAliases: ["/think"],
    acceptsArgs: true,
    args: [
      {
        name: "level",
        description: "Thinking level",
        type: "string",
        required: true,
      },
    ],
    argsParsing: "none",
    scope: "native",
  };
}

function createContext(
  discordConfig: NonNullable<OpenClawConfig["channels"]>["discord"],
): CommandArgContext {
  const cfg = {
    channels: {
      discord: discordConfig,
    },
  } as OpenClawConfig;
  return {
    cfg,
    discordConfig,
    accountId: "default",
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default"),
  };
}

function createInteraction(): CommandArgInteraction {
  return {
    user: {
      id: "owner",
      username: "tester",
      globalName: "Tester",
    },
    update: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as CommandArgInteraction;
}

async function safeInteractionCall<T>(_label: string, fn: () => Promise<T>): Promise<T | null> {
  return await fn();
}

function firstDispatchCall(dispatchSpy: { mock: { calls: unknown[][] } }) {
  const firstCall = dispatchSpy.mock.calls.at(0);
  if (!firstCall) {
    throw new Error("expected Discord command interaction dispatch");
  }
  return firstCall[0] as Parameters<DispatchDiscordCommandInteraction>[0];
}

describe("discord command argument fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves public slash command visibility for selected argument follow-ups", async () => {
    const commandDefinition = createCommandDefinition();
    vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockReturnValue(commandDefinition);
    const dispatchSpy = vi
      .fn<DispatchDiscordCommandInteraction>()
      .mockResolvedValue({ accepted: true });
    const button = createDiscordCommandArgFallbackButton({
      ctx: createContext({ slashCommand: { ephemeral: false } }),
      safeInteractionCall,
      dispatchCommandInteraction: dispatchSpy,
    });

    await button.run(createInteraction(), {
      command: "think",
      arg: "level",
      value: "high",
      user: "owner",
    } satisfies CommandArgData);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchCall = firstDispatchCall(dispatchSpy);
    expect(dispatchCall?.prompt).toBe("/think high");
    expect(dispatchCall?.responseEphemeral).toBe(false);
    expect(dispatchCall?.accountId).toBe("default");
    expect(dispatchCall?.sessionPrefix).toBe("discord:slash");
    expect(dispatchCall?.preferFollowUp).toBe(true);
  });
});
