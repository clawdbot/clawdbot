import { listNativeCommandSpecsForConfig as listRealNativeCommandSpecsForConfig } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { danger, warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordSetupPlugin } from "../channel.setup.js";
import { DISCORD_VOICE_COMMAND_SPEC } from "../voice/command.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";
import { createNoopThreadBindingManager } from "./thread-bindings.manager.js";

const retainNativeCatalog = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/plugin-command-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/plugin-command-runtime")>();
  return {
    ...actual,
    createPluginCommandRuntime: () => {
      const runtime = actual.createPluginCommandRuntime();
      return {
        ...runtime,
        retainNativeCatalog: (provider: string) => {
          retainNativeCatalog(provider);
          runtime.retainNativeCatalog(provider);
        },
      };
    },
  };
});

type ResolverParams = Parameters<typeof resolveDiscordProviderCommandSpecs>[0];
type SkillCommands = ReturnType<NonNullable<ResolverParams["listSkillCommandsForAgents"]>>;
type PluginCommandSpec = NativeCommandSpec & { nativeNames?: Partial<Record<string, string>> };

const cfg: OpenClawConfig = {};
const skillCommands = [
  { name: "skill-only", skillName: "Skill Only", description: "Skill only" },
  { name: "extra-skill", skillName: "Extra Skill", description: "Extra skill" },
];

function createResolverHarness(
  options: {
    pluginCommandSpecs?: PluginCommandSpec[];
    voiceEnabled?: boolean;
    nativeCommandSpecs?: NativeCommandSpec[];
    skillCommands?: SkillCommands;
    maxDiscordCommands?: number;
    nativeSkillsEnabled?: boolean;
  } = {},
) {
  const error = vi.fn();
  const log = vi.fn();
  const runtime: RuntimeEnv = { error, log, exit: vi.fn() };
  const configuredSkillCommands = options.skillCommands ?? skillCommands;
  const nativeCommandSpecs = options.nativeCommandSpecs ?? [
    { name: "built-in", description: "Built in", acceptsArgs: false },
  ];
  const listSkillCommandsForAgents = vi.fn(() => configuredSkillCommands);
  const listNativeCommandSpecsForConfig = vi.fn(
    (
      _config: OpenClawConfig,
      listOptions?: Parameters<NonNullable<ResolverParams["listNativeCommandSpecsForConfig"]>>[1],
    ): NativeCommandSpec[] => [
      ...nativeCommandSpecs,
      ...(listOptions?.skillCommands ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        acceptsArgs: true,
      })),
    ],
  );
  setActivePluginRegistry(createTestRegistry());
  for (const spec of options.pluginCommandSpecs ?? []) {
    expect(
      registerPluginCommand(`test-${spec.name}`, {
        name: spec.name,
        description: spec.description,
        descriptionLocalizations: spec.descriptionLocalizations,
        acceptsArgs: spec.acceptsArgs,
        nativeNames: spec.nativeNames,
        channels: ["discord"],
        handler: async () => ({ text: "ok" }),
      }),
    ).toEqual({ ok: true });
  }

  return {
    error,
    listNativeCommandSpecsForConfig,
    listSkillCommandsForAgents,
    log,
    resolve: () =>
      resolveDiscordProviderCommandSpecs({
        cfg,
        runtime,
        nativeEnabled: true,
        nativeSkillsEnabled: options.nativeSkillsEnabled ?? true,
        voiceEnabled: options.voiceEnabled ?? false,
        maxDiscordCommands: options.maxDiscordCommands ?? 3,
        listSkillCommandsForAgents,
        listNativeCommandSpecsForConfig,
      }),
  };
}

describe("resolveDiscordProviderCommandSpecs", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    retainNativeCatalog.mockClear();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each([
    {
      label: "primary name",
      name: "MiXeDPrimary",
      nativeNames: undefined,
      expectedName: "mixedprimary",
    },
    {
      label: "default alias",
      name: "primary-default",
      nativeNames: { default: "MiXeDDefault" },
      expectedName: "mixeddefault",
    },
    {
      label: "Discord alias",
      name: "primary-discord",
      nativeNames: { default: "MiXeDDefault", discord: "MiXeDDiscord" },
      expectedName: "mixeddiscord",
    },
  ])("deploys the normalized $label", async ({ name, nativeNames, expectedName }) => {
    const harness = createResolverHarness({
      nativeSkillsEnabled: false,
      pluginCommandSpecs: [
        { name, nativeNames, description: "Mixed-case command", acceptsArgs: false },
      ],
    });

    const resolved = await harness.resolve();
    const candidate = resolved.commandSpecs[1]!;
    expect(candidate.name).toBe(expectedName);
    const command = createDiscordNativeCommand({
      command: candidate,
      cfg,
      discordConfig: {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    expect(command.serialize().name).toBe(expectedName);
    expect(harness.error).not.toHaveBeenCalled();
  });

  it("keeps 32-character names and rejects 33-character names before command-cap planning", async () => {
    const exactLimitName = "a".repeat(32);
    const overLimitName = "b".repeat(33);
    const harness = createResolverHarness({
      maxDiscordCommands: 4,
      pluginCommandSpecs: [
        { name: exactLimitName, description: "At the limit", acceptsArgs: false },
        { name: overLimitName, description: "Over the limit", acceptsArgs: false },
      ],
    });

    const resolved = await harness.resolve();

    expect(resolved.skillCommands).toEqual(skillCommands);
    expect(resolved.commandSpecs.map((command) => command.name)).toEqual([
      "built-in",
      "skill-only",
      "extra-skill",
      exactLimitName,
    ]);
    expect(harness.error).toHaveBeenCalledOnce();
    expect(harness.error).toHaveBeenCalledWith(
      danger(
        `discord: plugin command "/${"b".repeat(32)}…" exceeds the 32-character name limit. Set a shorter Discord native alias. Skipping.`,
      ),
    );
    expect(harness.log).not.toHaveBeenCalled();
    expect(harness.listNativeCommandSpecsForConfig).toHaveBeenCalledOnce();
  });

  it("isolates an invalid plugin name and retains a later valid command's original dispatch", async () => {
    const overLimitName = "x".repeat(33);
    const harness = createResolverHarness({
      nativeSkillsEnabled: false,
      pluginCommandSpecs: [
        { name: overLimitName, description: "Invalid command", acceptsArgs: false },
        { name: "LaTeRValid", description: "Later valid command", acceptsArgs: false },
      ],
    });

    const resolved = await harness.resolve();

    expect(resolved.commandSpecs.map((command) => command.name)).toEqual([
      "built-in",
      "latervalid",
    ]);
    expect(harness.error).toHaveBeenCalledOnce();
    expect(retainNativeCatalog).toHaveBeenCalledExactlyOnceWith("discord");
    const candidate = resolved.commandSpecs[1]!;
    expect("prepareDispatch" in candidate).toBe(true);
    if (!("prepareDispatch" in candidate)) {
      throw new Error("expected the retained plugin command candidate");
    }
    const dispatch = candidate.prepareDispatch();
    expect(dispatch.kind).toBe("plugin");
    if (dispatch.kind !== "plugin") {
      throw new Error("expected the original plugin command dispatch");
    }
    await expect(
      dispatch.execute({
        channel: "discord",
        isAuthorizedSender: true,
        commandBody: "/latervalid",
        config: cfg,
      }),
    ).resolves.toEqual({ text: "ok" });
  });

  it("accepts a long primary command when its selected Discord alias is safe", async () => {
    const longPrimaryName = "p".repeat(40);
    const harness = createResolverHarness({
      nativeSkillsEnabled: false,
      pluginCommandSpecs: [
        {
          name: longPrimaryName,
          nativeNames: { default: "d".repeat(40), discord: "SaFeAlias" },
          description: "Long primary command",
          acceptsArgs: false,
        },
      ],
    });

    const resolved = await harness.resolve();

    expect(resolved.commandSpecs.map((command) => command.name)).toEqual(["built-in", "safealias"]);
    expect(getActivePluginRegistry()?.commands[0]?.command.name).toBe(longPrimaryName);
    expect(harness.error).not.toHaveBeenCalled();
  });

  it("preserves built-in precedence for a normalized Discord alias", async () => {
    const harness = createResolverHarness({
      nativeSkillsEnabled: false,
      pluginCommandSpecs: [
        {
          name: "plugin-shadow",
          nativeNames: { discord: "BuIlT-In" },
          description: "Built-in collision",
          acceptsArgs: false,
        },
        { name: "MiXeDSafe", description: "Safe command", acceptsArgs: false },
      ],
    });

    const resolved = await harness.resolve();

    expect(resolved.commandSpecs.map((command) => command.name)).toEqual(["built-in", "mixedsafe"]);
    expect(harness.error).toHaveBeenCalledExactlyOnceWith(
      danger(
        'discord: plugin command "/built-in" duplicates an existing native command. Skipping.',
      ),
    );
  });

  it("discards provisional skill collisions when command overflow removes skills", async () => {
    const harness = createResolverHarness({
      voiceEnabled: true,
      maxDiscordCommands: 4,
      pluginCommandSpecs: [
        {
          name: "skill-only",
          description: "Plugin skill alias",
          descriptionLocalizations: { de: "Plugin-Fertigkeitsalias" },
          acceptsArgs: false,
        },
        { name: "plugin-unique", description: "Unique plugin", acceptsArgs: false },
      ],
    });

    const resolved = await harness.resolve();

    expect(resolved.skillCommands).toEqual([]);
    expect(resolved.commandSpecs.map((command) => command.name)).toEqual([
      "built-in",
      "vc",
      "skill-only",
      "plugin-unique",
    ]);
    expect(resolved.commandSpecs[2]).toMatchObject({
      name: "skill-only",
      description: "Plugin skill alias",
      descriptionLocalizations: { de: "Plugin-Fertigkeitsalias" },
      acceptsArgs: false,
    });
    expect(harness.error).not.toHaveBeenCalled();
    expect(harness.listNativeCommandSpecsForConfig).toHaveBeenCalledTimes(2);
    expect(harness.log).toHaveBeenCalledOnce();
    expect(harness.log).toHaveBeenCalledWith(
      warn(
        "5 commands exceed the 4-command Discord limit; removing per-skill commands and keeping /skill.",
      ),
    );
    expect(retainNativeCatalog).toHaveBeenCalledOnce();
    expect(retainNativeCatalog).toHaveBeenCalledWith("discord");
  });

  it("logs a final built-in collision once when command overflow retries without skills", async () => {
    const harness = createResolverHarness({
      voiceEnabled: true,
      maxDiscordCommands: 4,
      pluginCommandSpecs: [
        { name: "built-in", description: "Built-in collision", acceptsArgs: false },
        { name: "plugin-unique", description: "Unique plugin", acceptsArgs: false },
      ],
    });

    const resolved = await harness.resolve();

    expect(resolved.skillCommands).toEqual([]);
    expect(resolved.commandSpecs.map((command) => command.name)).toEqual([
      "built-in",
      "vc",
      "plugin-unique",
    ]);
    expect(harness.error).toHaveBeenCalledOnce();
    expect(harness.error).toHaveBeenCalledWith(
      danger(
        'discord: plugin command "/built-in" duplicates an existing native command. Skipping.',
      ),
    );
    expect(harness.listNativeCommandSpecsForConfig).toHaveBeenCalledTimes(2);
  });

  it("counts voice in the exact Discord command limit", async () => {
    const harness = createResolverHarness({
      voiceEnabled: true,
      nativeSkillsEnabled: false,
      maxDiscordCommands: 100,
      nativeCommandSpecs: Array.from({ length: 99 }, (_value, index) => ({
        name: `command-${String(index + 1)}`,
        description: `Command ${String(index + 1)}`,
        acceptsArgs: false,
      })),
    });

    const resolved = await harness.resolve();

    expect(resolved.commandSpecs).toHaveLength(100);
    expect(resolved.commandSpecs.at(-1)).toBe(DISCORD_VOICE_COMMAND_SPEC);
    expect(harness.log).not.toHaveBeenCalled();
  });

  it("retains voice ownership when a plugin claims vc", async () => {
    const harness = createResolverHarness({
      voiceEnabled: true,
      nativeSkillsEnabled: false,
      maxDiscordCommands: 100,
      pluginCommandSpecs: [{ name: "vc", description: "Plugin voice", acceptsArgs: false }],
    });

    const resolved = await harness.resolve();

    expect(resolved.commandSpecs.map((command) => command.name)).toEqual(["built-in", "vc"]);
    expect(resolved.commandSpecs[1]).toBe(DISCORD_VOICE_COMMAND_SPEC);
    expect(harness.error).toHaveBeenCalledOnce();
    expect(harness.error).toHaveBeenCalledWith(
      danger('discord: plugin command "/vc" duplicates an existing native command. Skipping.'),
    );
    expect(retainNativeCatalog).not.toHaveBeenCalled();
  });

  it("keeps a skill named vc from shadowing or duplicating voice", async () => {
    const vcSkillCommands: SkillCommands = [
      { name: "vc", skillName: "Voice Skill", description: "Voice skill" },
    ];
    const harness = createResolverHarness({
      voiceEnabled: true,
      maxDiscordCommands: 100,
      skillCommands: vcSkillCommands,
    });

    const resolved = await harness.resolve();

    expect(resolved.skillCommands).toEqual(vcSkillCommands);
    expect(resolved.commandSpecs.map((command) => command.name)).toEqual(["built-in", "vc"]);
    expect(resolved.commandSpecs[1]).toBe(DISCORD_VOICE_COMMAND_SPEC);
    expect(harness.error).not.toHaveBeenCalled();
  });

  it("deduplicates provider-renamed primary specs before Discord cap planning", async () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin: discordSetupPlugin, source: "test" }]),
    );
    const voiceSkill: SkillCommands[number] = {
      name: "voice",
      skillName: "Voice Skill",
      description: "Skill voice",
    };
    const config: OpenClawConfig = { commands: { native: true, nativeSkills: true } };
    const rawPrimary = listRealNativeCommandSpecsForConfig(config, {
      provider: "discord",
      skillCommands: [voiceSkill],
    });
    const rawVoice = rawPrimary.filter(
      (spec) => normalizeLowercaseStringOrEmpty(spec.name) === "voice",
    );
    const uniqueCount = new Set(
      rawPrimary.map((spec) => normalizeLowercaseStringOrEmpty(spec.name)).filter(Boolean),
    ).size;
    expect(rawVoice).toHaveLength(2);
    expect(rawVoice.map((spec) => spec.description)).toEqual([
      "Control text-to-speech (TTS).",
      "Skill voice",
    ]);
    const log = vi.fn();

    const resolved = await resolveDiscordProviderCommandSpecs({
      cfg: config,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      nativeEnabled: true,
      nativeSkillsEnabled: true,
      voiceEnabled: false,
      maxDiscordCommands: uniqueCount,
      listSkillCommandsForAgents: vi.fn(() => [voiceSkill]),
    });

    expect(resolved.skillCommands).toEqual([voiceSkill]);
    expect(resolved.commandSpecs).toHaveLength(uniqueCount);
    expect(
      resolved.commandSpecs.filter(
        (spec) => normalizeLowercaseStringOrEmpty(spec.name) === "voice",
      ),
    ).toEqual([expect.objectContaining({ description: "Control text-to-speech (TTS)." })]);
    expect(log).not.toHaveBeenCalled();
  });
});
