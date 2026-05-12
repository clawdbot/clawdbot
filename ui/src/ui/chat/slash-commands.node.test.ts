// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseSlashCommand,
  refreshSlashCommands,
  resetSlashCommandsForTest,
  SLASH_COMMANDS,
} from "./slash-commands.ts";

afterEach(() => {
  resetSlashCommandsForTest();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      args: "[id] <message>",
      executeLocal: true,
    });
    expect(requireArray(steer.aliases, "steer aliases")).toEqual(["tell"]);
  });

  it("keeps focus as a local slash command", () => {
    expectParsedSlash("/focus", { key: "focus", executeLocal: true }, "");
  });

  it("refreshes runtime commands from commands.list so docks, plugins, and direct skills appear", async () => {
    const request = async (method: string) => {
      expect(method).toBe("commands.list");
      return {
        commands: [
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
        ],
      };
    };

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });

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

  it("does not let remote commands collide with reserved local commands", async () => {
    const request = async () => ({
      commands: [
        {
          name: "redirect",
          textAliases: ["/redirect"],
          description: "Remote redirect impostor.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
        {
          name: "kill",
          textAliases: ["/kill"],
          description: "Remote kill impostor.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
      ],
    });

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });

    expectRecordFields(requireCommandByName("redirect"), "redirect command", {
      key: "redirect",
      executeLocal: true,
      description: "Abort and restart with a new message",
    });
    expectRecordFields(requireCommandByName("kill"), "kill command", {
      key: "kill",
      executeLocal: true,
      description: "Kill a running subagent (or all).",
    });
  });

  it("drops remote commands with unsafe identifiers before they reach the palette/parser", async () => {
    const request = async () => ({
      commands: [
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
      ],
    });

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });

    expectRecordFields(requireCommandByName("safe-name"), "safe-name command", {
      name: "safe-name",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "prose now")).toBeUndefined();
    expect(SLASH_COMMANDS.find((entry) => entry.name === "bad:alias")).toBeUndefined();
    expectParsedSlash("/safe-name", { name: "safe-name" }, "");
  });

  it("caps remote command payload size and long metadata before it reaches UI state", async () => {
    const longName = "x".repeat(260);
    const longDescription = "d".repeat(2_500);
    const oversizedCommand = {
      name: "plugin-0",
      textAliases: Array.from({ length: 25 }, (_, aliasIndex) => `/plugin-0-${aliasIndex}`),
      description: longDescription,
      source: "plugin" as const,
      scope: "both" as const,
      acceptsArgs: true,
      args: Array.from({ length: 25 }, (_, argIndex) => ({
        name: `${longName}-${argIndex}`,
        description: longDescription,
        type: "string" as const,
        choices: Array.from({ length: 55 }, (_, choiceIndex) => ({
          value: `${longName}-${choiceIndex}`,
          label: `${longName}-${choiceIndex}`,
        })),
      })),
    };
    const request = async () => ({
      commands: [
        oversizedCommand,
        ...Array.from({ length: 519 }, (_, index) => ({
          name: `plugin-${index + 1}`,
          textAliases: [`/plugin-${index + 1}`],
          description: "Plugin command.",
          source: "plugin" as const,
          scope: "both" as const,
          acceptsArgs: false,
        })),
      ],
    });

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });

    const remoteCommands = SLASH_COMMANDS.filter((entry) => entry.name.startsWith("plugin-"));
    expect(remoteCommands).toHaveLength(500);
    const first = remoteCommands[0];
    expect(first.aliases).toHaveLength(19);
    expect(first.description.length).toBeLessThanOrEqual(2_000);
    expect(first.args?.split(" ")).toHaveLength(20);
    expect(first.argOptions).toHaveLength(50);
  });

  it("requests the gateway default agent when no explicit agentId is available", async () => {
    const request = vi.fn().mockResolvedValue({
      commands: [
        {
          name: "pair",
          textAliases: ["/pair"],
          description: "Generate setup codes.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
      ],
    });

    await refreshSlashCommands({
      client: { request } as never,
      agentId: undefined,
    });

    expect(request).toHaveBeenCalledWith("commands.list", {
      includeArgs: true,
      scope: "text",
    });
    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
      description: "Generate setup codes.",
      executeLocal: false,
      tier: "standard",
    });
  });

  it("falls back safely when the gateway returns malformed command payload shapes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ commands: { bad: "shape" } })
      .mockResolvedValueOnce({
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

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "pair")).toBeUndefined();
    expectRecordFields(requireCommandByName("help"), "help command", {
      key: "help",
      name: "help",
      executeLocal: true,
    });

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });
    expectRecordFields(requireCommandByName("valid"), "valid command", {
      name: "valid",
      description: "",
    });
    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
    });
  });

  it("ignores stale refresh responses and keeps the latest command set", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(async () => await first)
      .mockImplementationOnce(async () => ({
        commands: [
          {
            name: "pair",
            textAliases: ["/pair"],
            description: "Generate setup codes.",
            source: "plugin",
            scope: "both",
            acceptsArgs: true,
          },
        ],
      }));

    const pending = refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });
    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });
    if (resolveFirst) {
      resolveFirst({
        commands: [
          {
            name: "dreaming",
            textAliases: ["/dreaming"],
            description: "Enable or disable memory dreaming.",
            source: "plugin",
            scope: "both",
            acceptsArgs: true,
          },
        ],
      });
    }
    await pending;

    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
      description: "Generate setup codes.",
      executeLocal: false,
      tier: "standard",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "dreaming")).toBeUndefined();
  });
});
