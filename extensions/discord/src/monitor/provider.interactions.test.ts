import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { DISCORD_VOICE_COMMAND_SPEC } from "../voice/command.js";
import { createDiscordProviderInteractionSurface } from "./provider.interactions.js";
import { createNoopThreadBindingManager } from "./thread-bindings.manager.js";

type InteractionParams = Parameters<typeof createDiscordProviderInteractionSurface>[0];
type CreateNativeCommand = NonNullable<InteractionParams["createNativeCommand"]>;

const normalCommandSpec: NativeCommandSpec = {
  name: "normal",
  description: "Normal command",
  acceptsArgs: false,
};

function createInteractionHarness(params: {
  commandSpecs: NativeCommandSpec[];
  voiceEnabled: boolean;
}) {
  const createNativeCommand = vi.fn(
    (options: Parameters<CreateNativeCommand>[0]): ReturnType<CreateNativeCommand> =>
      ({ name: options.command.name }) as ReturnType<CreateNativeCommand>,
  );
  const surface = createDiscordProviderInteractionSurface({
    cfg: {} as OpenClawConfig,
    discordConfig: {
      agentComponents: { enabled: false },
      execApprovals: { enabled: false },
    } as DiscordAccountConfig,
    accountId: "default",
    token: "token",
    commandSpecs: params.commandSpecs,
    nativeEnabled: true,
    voiceEnabled: params.voiceEnabled,
    groupPolicy: "open",
    useAccessGroups: false,
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
    voiceManagerRef: { current: null },
    guildEntries: undefined,
    allowFrom: [],
    dmPolicy: "open",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv,
    createNativeCommand,
  });
  return { createNativeCommand, surface };
}

describe("createDiscordProviderInteractionSurface", () => {
  it("constructs the resolver-owned vc spec as the specialized voice command", () => {
    const { createNativeCommand, surface } = createInteractionHarness({
      commandSpecs: [normalCommandSpec, DISCORD_VOICE_COMMAND_SPEC],
      voiceEnabled: true,
    });

    expect(createNativeCommand).toHaveBeenCalledOnce();
    expect(createNativeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: normalCommandSpec }),
    );
    expect(surface.commands.map((command) => command.name)).toEqual(["normal", "vc"]);
    const voiceCommand = surface.commands[1];
    expect(voiceCommand?.serialize().options?.map((option) => option.name)).toEqual([
      "join",
      "leave",
      "status",
    ]);
  });

  it("does not append a hidden voice command when voice is disabled", () => {
    const { createNativeCommand, surface } = createInteractionHarness({
      commandSpecs: [normalCommandSpec],
      voiceEnabled: false,
    });

    expect(createNativeCommand).toHaveBeenCalledOnce();
    expect(surface.commands.map((command) => command.name)).toEqual(["normal"]);
  });
});
