import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const runtimeModuleMocks = vi.hoisted(() => ({
  dispatchReplyWithDispatcher: vi.fn(),
  resolveDirectStatusReplyForSession: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-dispatch-runtime")>(
    "openclaw/plugin-sdk/reply-dispatch-runtime",
  );
  return {
    ...actual,
    dispatchReplyWithDispatcher: (...args: unknown[]) =>
      runtimeModuleMocks.dispatchReplyWithDispatcher(...args),
  };
});

vi.mock("openclaw/plugin-sdk/command-status-runtime", () => ({
  resolveDirectStatusReplyForSession: (...args: unknown[]) =>
    runtimeModuleMocks.resolveDirectStatusReplyForSession(...args),
}));

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let discordNativeCommandTesting: typeof import("./native-command.js").__testing;

function createInteraction(params?: {
  channelType?: ChannelType;
  channelId?: string;
  threadParentId?: string | null;
  guildId?: string | null;
  guildName?: string;
}): MockCommandInteraction {
  return createMockCommandInteraction({
    userId: "owner",
    username: "tester",
    globalName: "Tester",
    channelType: params?.channelType ?? ChannelType.DM,
    channelId: params?.channelId ?? "dm-1",
    threadParentId: params?.threadParentId,
    guildId: params?.guildId ?? null,
    guildName: params?.guildName,
    interactionId: "interaction-1",
  });
}

function createConfig(params?: { requireMention?: boolean }): OpenClawConfig {
  return {
    commands: {
      useAccessGroups: false,
    },
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
        guilds: {
          guild1: {
            requireMention: true,
            channels: {
              chan1: {
                allow: true,
                requireMention: params?.requireMention ?? true,
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function createStatusCommand(cfg: OpenClawConfig) {
  return createDiscordNativeCommand({
    command: {
      name: "status",
      description: "Status",
      acceptsArgs: false,
    },
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function setDefaultRouteState() {
  discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async (params) => ({
    route: {
      agentId: "main",
      channel: "discord",
      accountId: params.accountId ?? "default",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    effectiveRoute: {
      agentId: "main",
      channel: "discord",
      accountId: params.accountId ?? "default",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    boundSessionKey: undefined,
    configuredRoute: null,
    configuredBinding: null,
    bindingReadiness: null,
  }));
}

function firstStatusCall(): {
  cfg: OpenClawConfig;
  sessionKey: string;
  channel: string;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
} {
  const call = runtimeModuleMocks.resolveDirectStatusReplyForSession.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected resolveDirectStatusReplyForSession to be called");
  }
  return call as {
    cfg: OpenClawConfig;
    sessionKey: string;
    channel: string;
    isGroup: boolean;
    defaultGroupActivation: () => "always" | "mention";
  };
}

describe("discord native /status", () => {
  beforeAll(async () => {
    ({ createDiscordNativeCommand, __testing: discordNativeCommandTesting } =
      await import("./native-command.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: {
        final: 0,
        block: 0,
        tool: 0,
      },
      queuedFinal: false,
    } as never);
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
      text: "status reply",
    });
    discordNativeCommandTesting.setDispatchReplyWithDispatcher(
      runtimeModuleMocks.dispatchReplyWithDispatcher as typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithDispatcher,
    );
    setDefaultRouteState();
  });

  it("returns a direct status reply without falling through the generic dispatcher", async () => {
    const cfg = createConfig();
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(runtimeModuleMocks.resolveDirectStatusReplyForSession).toHaveBeenCalledTimes(1);
    expect(runtimeModuleMocks.dispatchReplyWithDispatcher).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "status reply",
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("passes through the effective guild activation when requireMention is disabled", async () => {
    const cfg = createConfig({ requireMention: false });
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId: "chan1",
      guildId: "guild1",
      guildName: "Guild One",
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    const statusCall = firstStatusCall();
    expect(statusCall.channel).toBe("discord");
    expect(statusCall.isGroup).toBe(true);
    expect(statusCall.defaultGroupActivation()).toBe("always");
  });
});
