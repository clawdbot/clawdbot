// @vitest-environment node
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  getRemoteCommandEntries,
  parseSlashCommand,
  replaceSlashCommands,
  SLASH_COMMANDS,
} from "./commands.ts";

afterEach(() => {
  replaceSlashCommands(buildFallbackSlashCommands());
});

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value;
}

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

  it("builds runtime commands from command entries so docks, plugins, and direct skills appear", () => {
    applyRemoteEntries([
      {
        name: "dock-discord",
        textAliases: ["/dock-discord", "/dock_discord"],
        description: "Switch to discord for replies.",
        source: "native",
        scope: "both",
        acceptsArgs: false,
        category: "docks",
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
        name: "prose",
        textAliases: ["/prose"],
        description: "Draft polished prose.",
        source: "skill",
        scope: "both",
        acceptsArgs: true,
      },
    ]);

    expectRecordFields(requireCommandByName("dock-discord"), "dock-discord command", {
      aliases: ["dock_discord"],
      category: "tools",
      executeLocal: false,
    });
    expectRecordFields(requireCommandByName("dreaming"), "dreaming command", {
      key: "dreaming",
      executeLocal: false,
    });
    expectRecordFields(requireCommandByName("prose"), "prose command", {
      key: "prose",
      executeLocal: false,
    });
    expectParsedSlash("/dock_discord", { name: "dock-discord" }, "");
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
        name: "prose now",
        textAliases: ["/prose now", "/safe-name"],
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
