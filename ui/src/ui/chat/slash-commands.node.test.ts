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

describe("parseSlashCommand", () => {
  it("parses commands with an optional colon separator", () => {
    expect(parseSlashCommand("/think: high")).toMatchObject({
      command: { name: "think" },
      args: "high",
    });
    expect(parseSlashCommand("/think:high")).toMatchObject({
      command: { name: "think" },
      args: "high",
    });
    expect(parseSlashCommand("/help:")).toMatchObject({
      command: { name: "help" },
      args: "",
    });
  });

  it("still parses space-delimited commands", () => {
    expect(parseSlashCommand("/verbose full")).toMatchObject({
      command: { name: "verbose" },
      args: "full",
    });
  });

  it("parses fast commands", () => {
    expect(parseSlashCommand("/fast:on")).toMatchObject({
      command: { name: "fast" },
      args: "on",
    });
  });

  it("keeps /status on the agent path", () => {
    const status = SLASH_COMMANDS.find((entry) => entry.name === "status");
    expect(status?.executeLocal).not.toBe(true);
    expect(parseSlashCommand("/status")).toMatchObject({
      command: { name: "status" },
      args: "",
    });
  });

  it("includes shared /tools with shared arg hints", () => {
    const tools = SLASH_COMMANDS.find((entry) => entry.name === "tools");
    expect(tools).toMatchObject({
      key: "tools",
      description: "List available runtime tools.",
      argOptions: ["compact", "verbose"],
      executeLocal: false,
    });
    expect(parseSlashCommand("/tools verbose")).toMatchObject({
      command: { name: "tools" },
      args: "verbose",
    });
  });

  it("parses slash aliases through the shared registry", () => {
    const exportCommand = SLASH_COMMANDS.find((entry) => entry.key === "export-session");
    expect(exportCommand).toMatchObject({
      name: "export-session",
      aliases: ["export"],
      executeLocal: true,
    });
    expect(parseSlashCommand("/export")).toMatchObject({
      command: { key: "export-session" },
      args: "",
    });
    expect(parseSlashCommand("/export-session")).toMatchObject({
      command: { key: "export-session" },
      args: "",
    });
  });

  it("keeps canonical long-form slash names as the primary menu command", () => {
    expect(SLASH_COMMANDS.find((entry) => entry.key === "verbose")).toMatchObject({
      name: "verbose",
      aliases: ["v"],
    });
    expect(SLASH_COMMANDS.find((entry) => entry.key === "think")).toMatchObject({
      name: "think",
      aliases: expect.arrayContaining(["thinking", "t"]),
    });
  });

  it("keeps a single local /steer entry with the control-ui metadata", () => {
    const steerEntries = SLASH_COMMANDS.filter((entry) => entry.name === "steer");
    expect(steerEntries).toHaveLength(1);
    expect(steerEntries[0]).toMatchObject({
      key: "steer",
      description: "Inject a message into the active run",
      args: "[id] <message>",
      aliases: expect.arrayContaining(["tell"]),
      executeLocal: true,
    });
  });

  it("keeps focus as a local slash command", () => {
    expect(parseSlashCommand("/focus")).toMatchObject({
      command: { key: "focus", executeLocal: true },
      args: "",
    });
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

    expect(SLASH_COMMANDS.find((entry) => entry.name === "dock-discord")).toMatchObject({
      aliases: ["dock_discord"],
      category: "tools",
      executeLocal: false,
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "dreaming")).toMatchObject({
      key: "dreaming",
      executeLocal: false,
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "prose")).toMatchObject({
      key: "prose",
      executeLocal: false,
    });
    expect(parseSlashCommand("/dock_discord")).toMatchObject({
      command: { name: "dock-discord" },
      args: "",
    });
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

    expect(SLASH_COMMANDS.find((entry) => entry.name === "redirect")).toMatchObject({
      key: "redirect",
      executeLocal: true,
      description: "Abort and restart with a new message",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "kill")).toMatchObject({
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

    expect(SLASH_COMMANDS.find((entry) => entry.name === "safe-name")).toMatchObject({
      name: "safe-name",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "prose now")).toBeUndefined();
    expect(SLASH_COMMANDS.find((entry) => entry.name === "bad:alias")).toBeUndefined();
    expect(parseSlashCommand("/safe-name")).toMatchObject({
      command: { name: "safe-name" },
    });
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
    expect(SLASH_COMMANDS.find((entry) => entry.name === "pair")).toBeDefined();
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
    expect(SLASH_COMMANDS.find((entry) => entry.name === "help")).toBeDefined();

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "valid")).toMatchObject({
      name: "valid",
      description: "",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "pair")).toMatchObject({
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

    expect(SLASH_COMMANDS.find((entry) => entry.name === "pair")).toBeDefined();
    expect(SLASH_COMMANDS.find((entry) => entry.name === "dreaming")).toBeUndefined();
  });
});
