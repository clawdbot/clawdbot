import type { Command } from "commander";
import { inspectCommand, renderCommandInspectionMarkdown } from "../cli-catalog-overlay/inspect.js";
import { buildCatalogList, renderCatalogListMarkdown } from "../cli-catalog-overlay/list.js";
import { buildPluginCatalogCommands } from "../cli-catalog-overlay/plugin-commands.js";
import { collectRuntimeCommandTree } from "../cli-catalog-overlay/runtime-commands.js";
import { loadPluginCliDescriptorEntries } from "../plugins/cli-registry-loader.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

async function loadPluginCommands() {
  const entries = await withConsoleLogsRoutedToStderrForJson(
    ["--json"],
    async () => await loadPluginCliDescriptorEntries({}),
  );
  return buildPluginCatalogCommands(entries);
}

function validateOutputOptions(
  opts: { json?: boolean; markdown?: boolean },
  command: Command,
): void {
  if (opts.json && opts.markdown) {
    command.error("error: --json and --markdown cannot be combined");
  }
}

async function loadInspectedCommandGroup(
  program: Command,
  commandPath: readonly string[],
): Promise<void> {
  const root = commandPath[0];
  if (!root || root === "tools") {
    return;
  }
  const argv = ["node", "openclaw", ...commandPath];
  const [{ registerCoreCliByName }, { createProgramContext }, { registerSubCliByName }] =
    await Promise.all([
      import("./program/command-registry-core.js"),
      import("./program/context.js"),
      import("./program/register.subclis.js"),
    ]);
  if (await registerCoreCliByName(program, createProgramContext(), root, argv)) {
    return;
  }
  await registerSubCliByName(program, root, argv);
}

export function registerCommandsCli(program: Command): void {
  const inventoryRoot = program.parent ?? program;
  const commands = program.command("commands").description("List and inspect OpenClaw commands");

  commands
    .command("list")
    .description("List CLI, routed, runtime, and opt-in plugin commands")
    .option("--json", "Output JSON", false)
    .option("--markdown", "Output Markdown", false)
    .option("--plugin-descriptors", "Include plugin CLI descriptors", false)
    .action(
      async (
        opts: { json?: boolean; markdown?: boolean; pluginDescriptors?: boolean },
        command: Command,
      ) => {
        validateOutputOptions(opts, command);
        const runtimeCommands = collectRuntimeCommandTree(inventoryRoot);
        const pluginCommands = opts.pluginDescriptors ? await loadPluginCommands() : undefined;
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(buildCatalogList({ runtimeCommands, ...(pluginCommands ? { pluginCommands } : {}) }), null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${renderCatalogListMarkdown({ runtimeCommands, ...(pluginCommands ? { pluginCommands } : {}) })}\n`,
        );
      },
    );

  commands
    .command("inspect")
    .description("Inspect one exact command path")
    .argument("<command-path...>", "Command path to inspect")
    .option("--json", "Output JSON", false)
    .option("--markdown", "Output Markdown", false)
    .option("--plugin-descriptors", "Include plugin CLI descriptors", false)
    .action(
      async (
        commandPath: string[],
        opts: { json?: boolean; markdown?: boolean; pluginDescriptors?: boolean },
        command: Command,
      ) => {
        validateOutputOptions(opts, command);
        await loadInspectedCommandGroup(inventoryRoot, commandPath);
        const runtimeCommands = collectRuntimeCommandTree(inventoryRoot);
        const pluginCommands = opts.pluginDescriptors ? await loadPluginCommands() : undefined;
        const inspection = inspectCommand(
          buildCatalogList({
            runtimeCommands,
            ...(pluginCommands ? { pluginCommands } : {}),
          }),
          commandPath,
        );
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${renderCommandInspectionMarkdown(inspection)}\n`);
      },
    );

  applyParentDefaultHelpAction(commands);
}
