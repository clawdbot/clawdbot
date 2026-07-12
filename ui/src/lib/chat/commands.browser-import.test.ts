// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type CommandsModule = typeof import("./commands.js");
const browserImportPath = "./commands.ts?browser-import";

function importDeclarations(source: string): string[] {
  return (source.match(/^import[\s\S]*?;$/gmu) ?? []).map((declaration) =>
    declaration
      .replace(/\s+/gu, " ")
      .replace(/\{\s+/gu, "{ ")
      .replace(/,\s*\}/gu, " }")
      .replace(/\s+\}/gu, " }")
      .trim(),
  );
}

describe("slash command browser import", () => {
  it("builds fallback commands from the browser-safe shared registry", async () => {
    const mod = (await import(browserImportPath)) as CommandsModule;

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
    const commands = await readFile(new URL("./commands.ts", import.meta.url), "utf8");
    const sharedRegistry = await readFile(
      new URL("../../../../src/auto-reply/commands-registry.shared.ts", import.meta.url),
      "utf8",
    );
    const serverRegistry = await readFile(
      new URL("../../../../src/auto-reply/commands-registry.data.ts", import.meta.url),
      "utf8",
    );

    expect(importDeclarations(commands)).toEqual([
      'import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";',
      'import type { CommandEntry } from "../../../../packages/gateway-protocol/src/index.js";',
      'import { buildBuiltinChatCommands } from "../../../../src/auto-reply/commands-registry.shared.js";',
      'import { t } from "../../i18n/index.ts";',
      'import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";',
    ]);
    expect(importDeclarations(sharedRegistry)).toEqual([
      'import { normalizeOptionalLowercaseString } from "../../packages/normalization-core/src/string-coerce.js";',
      'import { normalizeStringEntries } from "../../packages/normalization-core/src/string-normalization.js";',
      'import { formatFastModeAutoLabel, resolveFastModeModelAutoOnSeconds } from "../shared/fast-mode.js";',
      'import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";',
      'import type { ChatCommandDefinition, CommandArgChoiceContext, CommandCategory, CommandScope, CommandTier } from "./commands-registry.types.js";',
      'import { BASE_THINKING_LEVELS, type ThinkLevel } from "./thinking.shared.js";',
    ]);
    expect(importDeclarations(serverRegistry)).toEqual([
      'import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";',
      'import { getActivePluginChannelRegistryVersionFromState } from "../plugins/runtime-channel-state.js";',
      'import { assertCommandRegistry, buildBuiltinChatCommands, defineChatCommand } from "./commands-registry.shared.js";',
      'import type { ChatCommandDefinition } from "./commands-registry.types.js";',
      'import { listThinkingLevels } from "./thinking.js";',
    ]);
  });
});
