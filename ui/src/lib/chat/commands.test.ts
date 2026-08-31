import { expectDefined } from "@openclaw/normalization-core";
// @vitest-environment node
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  findInlineSlashCompletion,
  getRemoteCommandEntries,
  getSkillCommandCompletions,
  getSlashCommandCompletions,
  parseSlashCommand,
  replaceSlashCommands,
  SLASH_COMMANDS,
  type SlashCommandDef,
} from "./commands.ts";

afterEach(() => {
  replaceSlashCommands(buildFallbackSlashCommands());
});

describe("findInlineSlashCompletion", () => {
  it("finds slash tokens at the start or in normal prose", () => {
    expect(findInlineSlashCompletion("/thi")).toEqual({
      query: "thi",
      start: 0,
      end: 4,
      inline: false,
    });
    expect(findInlineSlashCompletion("Please use /wea")).toEqual({
      query: "wea",
      start: 11,
      end: 15,
      inline: true,
    });
  });

  it("uses the caret and replaces the complete token", () => {
    expect(findInlineSlashCompletion("Use /weather tomorrow", 8)).toEqual({
      query: "wea",
      start: 4,
      end: 12,
      inline: true,
    });
    expect(findInlineSlashCompletion("/thinking please", 4)).toEqual({
      query: "thi",
      start: 0,
      end: 9,
      inline: true,
    });
  });

  it("recognizes a trailing colon as a skill-only inline reference", () => {
    expect(findInlineSlashCompletion("Please use /weather:")).toEqual({
      query: "weather",
      start: 11,
      end: 20,
      inline: true,
      skillOnly: true,
    });
  });

  it("ignores URLs, paths, and escaped double slashes", () => {
    expect(findInlineSlashCompletion("https://example.com/wea")).toBeNull();
    expect(findInlineSlashCompletion("Open tmp/wea")).toBeNull();
    expect(findInlineSlashCompletion("Use //wea")).toBeNull();
  });

  it("offers every non-skill command inline and can hide them when no command owner exists", () => {
    applyRemoteEntries([
      {
        name: "weather",
        textAliases: ["/weather"],
        description: "Weather skill",
        source: "skill",
        skillModelVisible: true,
        scope: "text",
        acceptsArgs: true,
      },
    ]);
    expect(
      getSlashCommandCompletions("weather", { inlineOnly: true }).map((entry) => entry.name),
    ).toEqual(["weather"]);
    expect(
      getSlashCommandCompletions("reset", { inlineOnly: true }).map((entry) => entry.name),
    ).toEqual(["reset"]);
    expect(
      getSlashCommandCompletions("elevated", { inlineOnly: true }).map((entry) => entry.name),
    ).toEqual(["elevated"]);
    expect(
      getSlashCommandCompletions("exec", { inlineOnly: true }).map((entry) => entry.name),
    ).toContain("exec");
    expect(
      getSlashCommandCompletions("think", { inlineOnly: true }).map((entry) => entry.name),
    ).toContain("think");
    expect(
      getSlashCommandCompletions("reset", {
        inlineOnly: true,
        allowImmediateInlineCommands: false,
      }),
    ).toEqual([]);
    expect(
      getSlashCommandCompletions("weather", {
        inlineOnly: true,
        allowImmediateInlineCommands: false,
      }).map((entry) => entry.name),
    ).toEqual(["weather"]);
  });
});

const requireRecord = createRequireRecord("record", "expected-label-object");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function requireCommandByName(name: string): Record<string, unknown> {
  return requireRecord(
    SLASH_COMMANDS.find((entry) => entry.name === name),
    `slash command ${name}`,
  );
}

function requireCommandByKey(key: string): Record<string, unknown> {
  return requireRecord(
    SLASH_COMMANDS.find((entry) => entry.key === key),
    `slash command ${key}`,
  );
}

function applyRemoteEntries(entries: Parameters<typeof buildSlashCommandsFromEntries>[0]) {
  replaceSlashCommands(buildSlashCommandsFromEntries(entries));
}

function applyCommandsListResult(result: { commands?: unknown }) {
  applyRemoteEntries(getRemoteCommandEntries(result));
}

function expectParsedSlash(input: string, commandFields: Record<string, unknown>, args: string) {
  const parsed = requireRecord(parseSlashCommand(input), `parsed ${input}`);
  expectRecordFields(parsed.command, `parsed ${input} command`, commandFields);
  expect(parsed.args).toBe(args);
}

function completionNames(filter: string, options?: { showAll?: boolean }): string[] {
  return getSlashCommandCompletions(filter, options).map((command) => command.name);
}

function slashCommand(
  name: string,
  options: Partial<Omit<SlashCommandDef, "key" | "name">> = {},
): SlashCommandDef {
  return { key: name, name, description: `${name} command.`, ...options };
}

describe("getSlashCommandCompletions", () => {
  it("ranks an exact name above prefixes and description-only matches", () => {
    replaceSlashCommands([
      slashCommand("openclaw", {
        description: "Run the setup and repair helper.",
        tier: "essential",
        category: "session",
      }),
      slashCommand("pair-device", {
        tier: "standard",
        category: "tools",
      }),
      slashCommand("pair", { tier: "power", category: "agents" }),
    ]);

    expect(completionNames("pair")).toEqual(["pair", "pair-device", "openclaw"]);
  });

  it("ranks exact and prefix alias matches like primary names", () => {
    replaceSlashCommands([
      slashCommand("pair-device", {
        tier: "power",
        category: "agents",
      }),
      slashCommand("connect", {
        aliases: ["pairing"],
        tier: "essential",
        category: "session",
      }),
      slashCommand("handoff", {
        aliases: ["pair"],
        tier: "power",
        category: "agents",
      }),
    ]);

    expect(completionNames("pair")).toEqual(["handoff", "connect", "pair-device"]);
  });

  it("ranks name and alias substrings above description-only matches", () => {
    replaceSlashCommands([
      slashCommand("helper", {
        description: "Repair a device.",
        tier: "essential",
        category: "session",
      }),
      slashCommand("connect", {
        aliases: ["repairing"],
        tier: "standard",
        category: "tools",
      }),
      slashCommand("repair", {
        tier: "power",
        category: "agents",
      }),
      slashCommand("pairing", {
        tier: "power",
        category: "agents",
      }),
    ]);

    expect(completionNames("pair")).toEqual(["pairing", "connect", "repair", "helper"]);
  });

  it("uses tier and category tie-breakers while keeping equal matches stable", () => {
    replaceSlashCommands([
      slashCommand("path-first", {
        tier: "essential",
        category: "session",
      }),
      slashCommand("path-standard", {
        tier: "standard",
        category: "session",
      }),
      slashCommand("path-agent", {
        tier: "essential",
        category: "agents",
      }),
      slashCommand("path-second", {
        tier: "essential",
        category: "session",
      }),
    ]);

    expect(completionNames("path-")).toEqual([
      "path-first",
      "path-second",
      "path-agent",
      "path-standard",
    ]);
  });

  it("keeps empty-query tier and category ordering unchanged", () => {
    replaceSlashCommands([
      slashCommand("standard-agent", {
        tier: "standard",
        category: "agents",
      }),
      slashCommand("essential-tools", {
        tier: "essential",
        category: "tools",
      }),
      slashCommand("power-session", {
        tier: "power",
        category: "session",
      }),
      slashCommand("essential-session", {
        tier: "essential",
        category: "session",
      }),
      slashCommand("standard-session", {
        tier: "standard",
        category: "session",
      }),
    ]);

    expect(completionNames("")).toEqual([
      "essential-session",
      "essential-tools",
      "standard-session",
      "standard-agent",
    ]);
    expect(completionNames("", { showAll: true })).toEqual([
      "essential-session",
      "essential-tools",
      "standard-session",
      "standard-agent",
      "power-session",
    ]);
  });
});

describe("parseSlashCommand", () => {
  it("parses commands with an optional colon separator", () => {
    expectParsedSlash("/think: high", { name: "think" }, "high");
    expectParsedSlash("/think:high", { name: "think" }, "high");
    expectParsedSlash("/help:", { name: "help" }, "");
  });

  it("still parses space-delimited commands", () => {
    expectParsedSlash("/verbose full", { name: "verbose" }, "full");
  });

  it("parses fast commands", () => {
    expectParsedSlash("/fast:on", { name: "fast" }, "on");
  });

  it("keeps /status on the agent path", () => {
    const status = SLASH_COMMANDS.find((entry) => entry.name === "status");
    expect(status?.executeLocal).not.toBe(true);
    expectParsedSlash("/status", { name: "status" }, "");
  });

  it("includes shared /tools with shared arg hints", () => {
    const tools = requireCommandByName("tools");
    expectRecordFields(tools, "tools command", {
      key: "tools",
      description: "List available runtime tools.",
      argOptions: ["compact", "verbose"],
      executeLocal: false,
    });
    expectParsedSlash("/tools verbose", { name: "tools" }, "verbose");
  });

  it("parses slash aliases through the shared registry", () => {
    const exportCommand = requireCommandByKey("export-session");
    expectRecordFields(exportCommand, "export-session command", {
      name: "export-session",
      aliases: ["export"],
      executeLocal: true,
    });
    expectParsedSlash("/export", { key: "export-session" }, "");
    expectParsedSlash("/export-session", { key: "export-session" }, "");
    const side = requireRecord(parseSlashCommand("/side what changed?"), "parsed /side");
    expectRecordFields(side.command, "side command", { key: "btw", name: "btw" });
    expect(
      requireArray(requireRecord(side.command, "side command").aliases, "side aliases"),
    ).toEqual(["side"]);
    expect(side.args).toBe("what changed?");
  });

  it("keeps canonical long-form slash names as the primary menu command", () => {
    expectRecordFields(requireCommandByKey("verbose"), "verbose command", {
      name: "verbose",
      aliases: ["v"],
    });
    const think = requireCommandByKey("think");
    expectRecordFields(think, "think command", {
      name: "think",
    });
    expect(requireArray(think.aliases, "think aliases")).toEqual(["thinking", "t"]);
  });

  it("keeps a single local /steer entry with the control-ui metadata", () => {
    const steerEntries = SLASH_COMMANDS.filter((entry) => entry.name === "steer");
    expect(steerEntries).toHaveLength(1);
    const steer = requireRecord(steerEntries[0], "steer command");
    expectRecordFields(steer, "steer command", {
      key: "steer",
      description: "Inject a message into the active run",
      args: "<message>",
      executeLocal: true,
    });
    expect(requireArray(steer.aliases, "steer aliases")).toEqual(["tell"]);
  });

  it("builds runtime commands from native, plugin, and direct skill entries", () => {
    applyRemoteEntries([
      {
        name: "inspect-session",
        textAliases: ["/inspect-session", "/inspect_session"],
        description: "Inspect the active session.",
        source: "native",
        scope: "both",
        acceptsArgs: false,
        category: "tools",
      },
      {
        name: "dreaming",
        textAliases: ["/dreaming"],
        description: "Enable or disable memory dreaming.",
        source: "plugin",
        scope: "both",
        acceptsArgs: true,
      },
      {
        name: "draft",
        textAliases: ["/draft"],
        description: "Draft polished prose.",
        source: "skill",
        skillModelVisible: true,
        scope: "both",
        acceptsArgs: true,
      },
    ]);

    expectRecordFields(requireCommandByName("inspect-session"), "inspect-session command", {
      aliases: ["inspect_session"],
      category: "tools",
      executeLocal: false,
    });
    expectRecordFields(requireCommandByName("dreaming"), "dreaming command", {
      key: "dreaming",
      executeLocal: false,
    });
    expectRecordFields(requireCommandByName("draft"), "draft command", {
      key: "draft",
      executeLocal: false,
      source: "skill",
      skillModelVisible: true,
    });
    expectParsedSlash("/inspect_session", { name: "inspect-session" }, "");
    expect(getSkillCommandCompletions("dra").map((command) => command.name)).toEqual(["draft"]);
  });

  it("matches skill queries against both display titles and command tokens", () => {
    applyRemoteEntries([
      {
        name: "release_notes",
        skillDisplayName: "Release Notes",
        textAliases: ["/release_notes"],
        description: "Draft release notes.",
        source: "skill",
        skillModelVisible: true,
        scope: "both",
        acceptsArgs: true,
      },
    ]);

    expect(getSkillCommandCompletions("notes")).toMatchObject([
      { name: "release_notes", skillDisplayName: "Release Notes" },
    ]);
    expect(getSkillCommandCompletions("release_n")).toMatchObject([
      { name: "release_notes", skillDisplayName: "Release Notes" },
    ]);
  });

  it("keeps model-hidden skills in slash commands but out of $ completions", () => {
    applyRemoteEntries([
      {
        name: "hidden_skill",
        textAliases: ["/hidden_skill"],
        description: "Slash-only skill.",
        source: "skill",
        skillModelVisible: false,
        scope: "both",
        acceptsArgs: true,
      },
    ]);

    expectParsedSlash("/hidden_skill", { name: "hidden_skill" }, "");
    expect(getSkillCommandCompletions("hidden")).toEqual([]);
  });

  it("fails closed when an older gateway omits skill visibility metadata", () => {
    applyRemoteEntries([
      {
        name: "legacy_skill",
        textAliases: ["/legacy_skill"],
        description: "Legacy skill command.",
        source: "skill",
        scope: "both",
        acceptsArgs: true,
      },
    ]);

    expectParsedSlash("/legacy_skill", { name: "legacy_skill" }, "");
    expect(getSkillCommandCompletions("legacy")).toEqual([]);
  });

  it("does not let remote commands collide with reserved local commands", () => {
    applyRemoteEntries([
      {
        name: "redirect",
        textAliases: ["/redirect"],
        description: "Remote redirect impostor.",
        source: "plugin",
        scope: "both",
        acceptsArgs: true,
      },
    ]);

    expectRecordFields(requireCommandByName("redirect"), "redirect command", {
      key: "redirect",
      executeLocal: true,
      description: "Abort and restart with a new message",
    });
  });

  it("drops remote commands with unsafe identifiers before they reach the palette/parser", () => {
    applyRemoteEntries([
      {
        name: "draft now",
        textAliases: ["/draft now", "/safe-name"],
        description: "Unsafe injected command.",
        source: "skill",
        scope: "both",
        acceptsArgs: true,
      },
      {
        name: "bad:alias",
        textAliases: ["/bad:alias"],
        description: "Unsafe alias command.",
        source: "plugin",
        scope: "both",
        acceptsArgs: false,
      },
    ]);

    expectRecordFields(requireCommandByName("safe-name"), "safe-name command", {
      name: "safe-name",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "prose now")).toBeUndefined();
    expect(SLASH_COMMANDS.find((entry) => entry.name === "bad:alias")).toBeUndefined();
    expectParsedSlash("/safe-name", { name: "safe-name" }, "");
  });

  it("caps remote command payload size and long metadata before it reaches UI state", () => {
    const longName = "x".repeat(260);
    const longDescription = `${"d".repeat(1_999)}🚀tail`;
    const boundaryArgName = `${"n".repeat(199)}🚀tail`;
    const oversizedCommand = {
      name: "plugin-0",
      textAliases: Array.from({ length: 25 }, (_, aliasIndex) => `/plugin-0-${aliasIndex}`),
      description: longDescription,
      source: "plugin" as const,
      scope: "both" as const,
      acceptsArgs: true,
      args: Array.from({ length: 25 }, (_, argIndex) => ({
        name: argIndex === 0 ? boundaryArgName : `${longName}-${argIndex}`,
        description: longDescription,
        type: "string" as const,
        choices: Array.from({ length: 55 }, (_Local, choiceIndex) => ({
          value: `${longName}-${choiceIndex}`,
          label: `${longName}-${choiceIndex}`,
        })),
      })),
    };
    applyRemoteEntries([
      oversizedCommand,
      ...Array.from({ length: 519 }, (_, index) => ({
        name: `plugin-${index + 1}`,
        textAliases: [`/plugin-${index + 1}`],
        description: "Plugin command.",
        source: "plugin" as const,
        scope: "both" as const,
        acceptsArgs: false,
      })),
    ]);

    const remoteCommands = SLASH_COMMANDS.filter((entry) => entry.name.startsWith("plugin-"));
    expect(remoteCommands).toHaveLength(500);
    const first = expectDefined(remoteCommands[0], "first capped remote command");
    expect(first.aliases).toHaveLength(19);
    expect(first.description).toBe("d".repeat(1_999));
    expect(first.args?.split(" ")).toHaveLength(20);
    expect(first.args?.split(" ")[0]).toBe("[" + "n".repeat(199) + "]");
    expect(first.argOptions).toHaveLength(50);
  });

  it("preserves only known closed plugin client presentation metadata", () => {
    applyRemoteEntries([
      {
        name: "pair",
        textAliases: ["/pair"],
        description: "Pair a device.",
        source: "plugin",
        scope: "both",
        acceptsArgs: true,
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing" },
        },
      },
    ]);

    expect(requireCommandByName("pair").clientPresentation).toEqual({
      when: "no-arguments",
      action: { kind: "device-pairing" },
    });
  });

  it.each([
    { when: "always", action: { kind: "device-pairing" } },
    { when: "no-arguments", action: { kind: "open-route" } },
    { when: "no-arguments", action: { kind: "device-pairing", callback: "run" } },
    {
      when: "no-arguments",
      action: { kind: "device-pairing" },
      route: "/settings/devices",
    },
  ])("drops malformed client presentation metadata %#", (clientPresentation) => {
    applyCommandsListResult({
      commands: [
        {
          name: "pair",
          textAliases: ["/pair"],
          description: "Pair a device.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
          clientPresentation,
        },
      ],
    });

    expect(requireCommandByName("pair").clientPresentation).toBeUndefined();
  });

  it("falls back safely when command payload shapes are malformed", () => {
    applyCommandsListResult({ commands: { bad: "shape" } });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "pair")).toBeUndefined();
    expectRecordFields(requireCommandByName("help"), "help command", {
      key: "help",
      name: "help",
      executeLocal: true,
    });

    applyCommandsListResult({
      commands: [
        {
          name: "valid",
          textAliases: ["/valid"],
          description: 42,
          args: { nope: true },
        },
        {
          name: "pair",
          textAliases: ["/pair"],
          description: "Generate setup codes.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
          args: [
            {
              name: "mode",
              required: "yes",
              choices: { broken: true },
            },
          ],
        },
      ],
    });
    expectRecordFields(requireCommandByName("valid"), "valid command", {
      name: "valid",
      description: "",
    });
    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
    });
  });
});
