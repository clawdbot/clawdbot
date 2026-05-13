// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type SlashCommandsModule = typeof import("./slash-commands.js");
const browserImportPath: string = "./slash-commands.ts?browser-import";

function importLines(source: string): string[] {
  return source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("import "))
    .map((line) => line.trim());
}

describe("slash command browser import", () => {
  it("builds fallback commands from the browser-safe shared registry", async () => {
    const mod = (await import(browserImportPath)) as SlashCommandsModule;

    const thinkCommand = mod.SLASH_COMMANDS.find((command) => command.name === "think");
    expect(thinkCommand).toEqual({
      key: "think",
      name: "think",
      aliases: ["thinking", "t"],
      description: "Set thinking level.",
      category: "model",
      args: "[level]",
      icon: "brain",
      executeLocal: true,
      argOptions: undefined,
      tier: "essential",
    });
  });

  it("keeps provider thinking runtime out of the Control UI import path", async () => {
    const slashCommands = await readFile(new URL("./slash-commands.ts", import.meta.url), "utf8");
    const sharedRegistry = await readFile(
      new URL("../../../../src/auto-reply/commands-registry.shared.ts", import.meta.url),
      "utf8",
    );
    const serverRegistry = await readFile(
      new URL("../../../../src/auto-reply/commands-registry.data.ts", import.meta.url),
      "utf8",
    );
    const mod = (await import(browserImportPath)) as SlashCommandsModule;

    expect(mod.SLASH_COMMANDS.find((command) => command.name === "think")).toEqual({
      key: "think",
      name: "think",
      aliases: ["thinking", "t"],
      description: "Set thinking level.",
      category: "model",
      args: "[level]",
      icon: "brain",
      executeLocal: true,
      argOptions: undefined,
      tier: "essential",
    });
    expect(importLines(slashCommands)).toEqual([
      'import { buildBuiltinChatCommands } from "../../../../src/auto-reply/commands-registry.shared.js";',
      'import type { CommandEntry, CommandsListResult } from "../../../../src/gateway/protocol/index.js";',
      'import type { GatewayBrowserClient } from "../gateway.ts";',
      'import type { IconName } from "../icons.ts";',
      'import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";',
    ]);
    expect(importLines(sharedRegistry)).toEqual([
      'import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";',
      'import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";',
      "import type {",
      'import { BASE_THINKING_LEVELS, type ThinkLevel } from "./thinking.shared.js";',
    ]);
    expect(importLines(serverRegistry)).toEqual([
      'import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";',
      'import { getActivePluginChannelRegistryVersionFromState } from "../plugins/runtime-channel-state.js";',
      "import {",
      'import type { ChatCommandDefinition } from "./commands-registry.types.js";',
      'import { listThinkingLevels } from "./thinking.js";',
    ]);
  });
});
