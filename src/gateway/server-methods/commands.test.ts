import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCommandDefinition } from "../../auto-reply/commands-registry.types.js";

const mockSkillCommands = [
  {
    skillName: "code-review",
    name: "code_review",
    description: "Run code review",
    acceptsArgs: true,
  },
];

const mockChatCommands: ChatCommandDefinition[] = [
  {
    key: "model",
    nativeName: "model",
    description: "Set model",
    textAliases: ["/model", "/m"],
    acceptsArgs: true,
    args: [
      {
        name: "model",
        description: "Model identifier",
        type: "string",
        choices: [{ value: "gpt-5.4", label: "GPT-5.4" }, "sonnet-4.6"],
      },
    ],
    scope: "both",
    category: "options",
  },
  {
    key: "help",
    nativeName: "help",
    description: "Show help",
    textAliases: ["/help"],
    scope: "both",
    category: "session",
  },
  {
    key: "commands",
    description: "List commands",
    textAliases: ["/commands"],
    scope: "text",
    category: "session",
  },
  {
    key: "skill:code-review",
    nativeName: "code_review",
    description: "Run code review",
    textAliases: ["/code_review"],
    acceptsArgs: true,
    scope: "both",
    category: "tools",
  },
  {
    key: "debug_prompt",
    nativeName: "debug_prompt",
    description: "Show raw prompt",
    textAliases: ["/debug"],
    acceptsArgs: false,
    args: [
      {
        name: "target",
        description: "Prompt target",
        type: "string",
        choices: () => [{ value: "last", label: "Last" }],
      },
    ],
    scope: "native",
    category: "tools",
  },
];

const mockPluginSpecs = [{ name: "tts", description: "Text to speech", acceptsArgs: false }];

vi.mock("../../auto-reply/commands-registry.js", () => ({
  listChatCommandsForConfig: vi.fn(() => mockChatCommands),
}));
vi.mock("../../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents: vi.fn(() => mockSkillCommands),
}));
vi.mock("../../plugins/command-registry-state.js", () => ({
  getPluginCommandSpecs: vi.fn((provider?: string) => {
    if (provider === "whatsapp") {
      return [];
    }
    if (provider === "discord") {
      return [{ name: "discord_tts", description: "Text to speech", acceptsArgs: false }];
    }
    return mockPluginSpecs;
  }),
}));
vi.mock("../../plugins/commands.js", () => ({
  listPluginCommands: vi.fn(() => [
    {
      name: "tts",
      description: "Text to speech",
      pluginId: "plugin-tts",
      acceptsArgs: false,
    },
  ]),
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main", "dev"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));
vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: vi.fn((provider: string) => {
    if (provider === "discord") {
      return {
        commands: {
          resolveNativeCommandName: ({
            commandKey,
            defaultName,
          }: {
            commandKey: string;
            defaultName: string;
          }) => {
            if (commandKey === "model") {
              return "set_model";
            }
            return defaultName;
          },
        },
      };
    }
    return undefined;
  }),
  getChannelPlugin: vi.fn((provider: string) => {
    if (provider === "discord") {
      return {
        commands: {
          resolveNativeCommandName: ({
            commandKey,
            defaultName,
          }: {
            commandKey: string;
            defaultName: string;
          }) => {
            if (commandKey === "model") {
              return "set_model";
            }
            return defaultName;
          },
        },
      };
    }
    return undefined;
  }),
}));

import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  COMMAND_ALIAS_MAX_ITEMS,
  COMMAND_ARG_CHOICES_MAX_ITEMS,
  COMMAND_ARGS_MAX_ITEMS,
  COMMAND_DESCRIPTION_MAX_LENGTH,
  COMMAND_LIST_MAX_ITEMS,
  COMMAND_NAME_MAX_LENGTH,
} from "../protocol/schema/commands.js";
import { commandsHandlers, buildCommandsListResult } from "./commands.js";

function callHandler(params: Record<string, unknown> = {}) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    result = { ok, payload, error };
  };
  void commandsHandlers["commands.list"]({
    params,
    respond,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
    context: {} as never,
  });
  return result!;
}

describe("commands.list handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all command sources", () => {
    const { ok, payload } = callHandler();
    expect(ok).toBe(true);
    const { commands } = payload as { commands: Array<{ name: string; source: string }> };
    const sources = new Set(commands.map((c) => c.source));
    expect(sources).toEqual(new Set(["native", "skill", "plugin"]));
  });

  it("maps native commands with category, scope, and args", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Array<Record<string, unknown>> };
    const model = commands.find((c) => c.name === "model");
    expect(model).toMatchObject({
      name: "model",
      nativeName: "model",
      textAliases: ["/model", "/m"],
      description: "Set model",
      category: "options",
      source: "native",
      scope: "both",
      acceptsArgs: true,
    });
    const args = model!.args as Array<Record<string, unknown>>;
    expect(args).toHaveLength(1);
    expect(args[0].choices).toEqual([
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "sonnet-4.6", label: "sonnet-4.6" },
    ]);
  });

  it("exposes per-command scope", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Array<{ name: string; scope: string }> };
    expect(commands.find((c) => c.name === "model")!.scope).toBe("both");
    expect(commands.find((c) => c.name === "commands")!.scope).toBe("text");
    expect(commands.find((c) => c.name === "debug_prompt")!.scope).toBe("native");
    expect(commands.find((c) => c.name === "tts")!.scope).toBe("both");
  });

  it("skips args when acceptsArgs is false", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Array<Record<string, unknown>> };
    const debug = commands.find((c) => c.name === "debug_prompt");
    expect(debug!.args).toBeUndefined();
  });

  it("serializes dynamic choices when acceptsArgs is true", () => {
    const debugCmd = mockChatCommands.find((c) => c.key === "debug_prompt")!;
    const saved = debugCmd.acceptsArgs;
    debugCmd.acceptsArgs = true;
    try {
      const { payload } = callHandler();
      const { commands } = payload as { commands: Array<Record<string, unknown>> };
      const debug = commands.find((c) => c.name === "debug_prompt");
      const args = debug!.args as Array<Record<string, unknown>>;
      expect(args[0].dynamic).toBe(true);
      expect(args[0].choices).toBeUndefined();
    } finally {
      debugCmd.acceptsArgs = saved;
    }
  });

  it("identifies skill commands by source", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Array<Record<string, unknown>> };
    const skill = commands.find((c) => c.name === "code_review");
    expect(skill).toMatchObject({ source: "skill", category: "tools" });
  });

  it("always includes plugin commands regardless of scope filter", () => {
    for (const scope of ["native", "text", "both"] as const) {
      const { payload } = callHandler({ scope });
      const { commands } = payload as { commands: Array<{ name: string; source: string }> };
      expect(commands.some((c) => c.source === "plugin")).toBe(true);
    }
  });

  it("filters built-in commands by scope=native (excludes text-only)", () => {
    const { payload } = callHandler({ scope: "native" });
    const { commands } = payload as { commands: Array<{ name: string; source: string }> };
    const builtinNames = commands.filter((c) => c.source !== "plugin").map((c) => c.name);
    expect(builtinNames).not.toContain("commands");
    expect(builtinNames).toContain("model");
    expect(builtinNames).toContain("debug_prompt");
  });

  it("filters built-in commands by scope=text (excludes native-only)", () => {
    const { payload } = callHandler({ scope: "text" });
    const { commands } = payload as { commands: Array<{ name: string; source: string }> };
    const builtinNames = commands.filter((c) => c.source !== "plugin").map((c) => c.name);
    expect(builtinNames).toContain("commands");
    expect(builtinNames).not.toContain("debug_prompt");
  });

  it("resolves provider-specific native names", () => {
    const { payload } = callHandler({ provider: "discord" });
    const { commands } = payload as { commands: Array<{ name: string }> };
    expect(commands.find((c) => c.name === "set_model")).toBeDefined();
    expect(commands.find((c) => c.name === "model")).toBeUndefined();
  });

  it("normalizes mixed-case provider", () => {
    const { payload } = callHandler({ provider: "Discord" });
    const { commands } = payload as { commands: Array<{ name: string; source: string }> };
    expect(commands.find((c) => c.name === "set_model")).toBeDefined();
    const plugin = commands.find((c) => c.source === "plugin");
    expect(plugin).toMatchObject({ name: "discord_tts" });
  });

  it("uses default names without provider", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Array<{ name: string }> };
    expect(commands.find((c) => c.name === "model")).toBeDefined();
    expect(commands.find((c) => c.name === "set_model")).toBeUndefined();
  });

  it("omits plugin commands when provider lacks nativeCommandsAutoEnabled", () => {
    const { payload } = callHandler({ provider: "whatsapp" });
    const { commands } = payload as { commands: Array<{ name: string; source: string }> };
    expect(commands.filter((c) => c.source === "plugin")).toEqual([]);
  });

  it("uses text-surface names when scope=text even with provider-native aliases", () => {
    const { payload } = callHandler({ provider: "discord", scope: "text" });
    const { commands } = payload as {
      commands: Array<{
        name: string;
        nativeName?: string;
        textAliases?: string[];
        source: string;
      }>;
    };
    const model = commands.find((c) => c.source === "native" && c.name === "model");
    expect(model).toMatchObject({
      name: "model",
      nativeName: "set_model",
      textAliases: ["/model", "/m"],
    });
    expect(commands.find((c) => c.name === "set_model")).toBeUndefined();
  });

  it("keeps plugin text commands visible for scope=text even without native provider support", () => {
    const { payload } = callHandler({ provider: "whatsapp", scope: "text" });
    const { commands } = payload as {
      commands: Array<{
        name: string;
        source: string;
        textAliases?: string[];
        nativeName?: string;
      }>;
    };
    expect(commands.find((c) => c.source === "plugin")).toMatchObject({
      name: "tts",
      textAliases: ["/tts"],
    });
    expect(commands.find((c) => c.source === "plugin")?.nativeName).toBeUndefined();
  });

  it("keeps plugin text names while exposing provider-native aliases for scope=text", () => {
    const { payload } = callHandler({ provider: "discord", scope: "text" });
    const { commands } = payload as {
      commands: Array<{
        name: string;
        source: string;
        textAliases?: string[];
        nativeName?: string;
      }>;
    };
    expect(commands.find((c) => c.source === "plugin")).toMatchObject({
      name: "tts",
      nativeName: "discord_tts",
      textAliases: ["/tts"],
    });
  });

  it("returns provider-specific plugin command names", () => {
    const { payload } = callHandler({ provider: "discord" });
    const { commands } = payload as { commands: Array<{ name: string; source: string }> };
    const plugin = commands.find((c) => c.source === "plugin");
    expect(plugin).toMatchObject({ name: "discord_tts" });
  });

  it("excludes args when includeArgs=false", () => {
    const { payload } = callHandler({ includeArgs: false });
    const { commands } = payload as { commands: Array<Record<string, unknown>> };
    const model = commands.find((c) => c.name === "model");
    expect(model!.args).toBeUndefined();
  });

  it("caps serialized command payload size and field lengths", () => {
    const originalCommands = [...mockChatCommands];
    const longToken = "x".repeat(COMMAND_NAME_MAX_LENGTH + 50);
    const aliasBase = "alias".repeat(20);
    const longDescription = "d".repeat(COMMAND_DESCRIPTION_MAX_LENGTH + 50);
    const oversizedArgs = Array.from({ length: COMMAND_ARGS_MAX_ITEMS + 5 }, (_, argIndex) => ({
      name: `${longToken}-${argIndex}`,
      description: longDescription,
      type: "string" as const,
      choices: Array.from({ length: COMMAND_ARG_CHOICES_MAX_ITEMS + 5 }, (_, choiceIndex) => ({
        value: `${longToken}-${choiceIndex}`,
        label: `${longToken}-${choiceIndex}`,
      })),
    }));
    try {
      mockChatCommands.length = 0;
      for (let index = 0; index < COMMAND_LIST_MAX_ITEMS + 25; index += 1) {
        const isFirst = index === 0;
        mockChatCommands.push({
          key: isFirst ? longToken : `cmd-${index}`,
          description: isFirst ? longDescription : "short",
          textAliases: isFirst
            ? Array.from(
                { length: COMMAND_ALIAS_MAX_ITEMS + 5 },
                (_, aliasIndex) => `/${aliasBase}-${index}-${aliasIndex}`,
              )
            : [`/cmd-${index}`],
          acceptsArgs: isFirst,
          args: isFirst ? oversizedArgs : undefined,
          scope: "both",
          category: "tools",
        });
      }

      const { payload } = callHandler();
      const { commands } = payload as { commands: Array<Record<string, unknown>> };
      expect(commands).toHaveLength(COMMAND_LIST_MAX_ITEMS);
      const first = commands[0];
      expect((first.name as string).length).toBeLessThanOrEqual(COMMAND_NAME_MAX_LENGTH);
      expect((first.description as string).length).toBeLessThanOrEqual(
        COMMAND_DESCRIPTION_MAX_LENGTH,
      );
      expect((first.textAliases as unknown[]).length).toBeLessThanOrEqual(COMMAND_ALIAS_MAX_ITEMS);
      expect(first.args as unknown[]).toHaveLength(COMMAND_ARGS_MAX_ITEMS);
      const firstArg = (first.args as Array<Record<string, unknown>>)[0];
      expect(firstArg.choices as unknown[]).toHaveLength(COMMAND_ARG_CHOICES_MAX_ITEMS);
    } finally {
      mockChatCommands.length = 0;
      mockChatCommands.push(...originalCommands);
    }
  });

  it("rejects unknown agentId", () => {
    const { ok, error } = callHandler({ agentId: "nonexistent" });
    expect(ok).toBe(false);
    expect(error).toEqual(errorShape(ErrorCodes.INVALID_REQUEST, 'unknown agent id "nonexistent"'));
  });

  it("rejects invalid params", () => {
    const { ok, error } = callHandler({ scope: "invalid" });
    expect(ok).toBe(false);
    expect((error as { code: number }).code).toBe(ErrorCodes.INVALID_REQUEST);
  });
});

describe("buildCommandsListResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is callable independently from handler", () => {
    const result = buildCommandsListResult({ cfg: {} as never, agentId: "main" });
    expect(result.commands.length).toBeGreaterThan(0);
    expect(result.commands.every((c) => typeof c.scope === "string")).toBe(true);
  });
});
