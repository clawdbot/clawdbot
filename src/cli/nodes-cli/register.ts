// Root `nodes` command registration: wires node status, pairing, invoke, media, and plugin extensions.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { formatHelpExamples } from "../help-format.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";
import { registerNodesCameraCommands } from "./register.camera.js";
import { registerNodesInvokeCommands } from "./register.invoke.js";
import { registerNodesLocationCommands } from "./register.location.js";
import { registerNodesNotifyCommand } from "./register.notify.js";
import { registerNodesPairingCommands } from "./register.pairing.js";
import { registerNodesPushCommand } from "./register.push.js";
import { registerNodesScreenCommands } from "./register.screen.js";
import { registerNodesStatusCommands } from "./register.status.js";

/** Register the `nodes` command group and lazy plugin-provided node commands. */
export async function registerNodesCli(program: Command, argv: readonly string[] = process.argv) {
  const nodes = program
    .command("nodes")
    .description("Manage gateway-owned nodes (pairing, status, invoke, and media)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw nodes status", "List known nodes with live status."],
          ["openclaw nodes pairing pending", "Show pending node pairing requests."],
          ["openclaw nodes remove --node <id|name|ip>", "Remove a stale paired node entry."],
          [
            'openclaw nodes invoke --node <id> --command system.which --params \'{"bins":["uname"]}\'',
            "Invoke a node command directly.",
          ],
          ["openclaw nodes camera snap --node <id>", "Capture a photo from a node camera."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/nodes", "docs.openclaw.ai/cli/nodes")}\n`,
    );

  registerNodesStatusCommands(nodes);
  registerNodesPairingCommands(nodes);
  registerNodesInvokeCommands(nodes);
  registerNodesNotifyCommand(nodes);
  registerNodesPushCommand(nodes);
  registerNodesCameraCommands(nodes);
  registerNodesScreenCommands(nodes);
  registerNodesLocationCommands(nodes);

  // Built-in `nodes` subcommands (status/list/pairing/invoke/...) must stay on the lightweight
  // path: loading plugin CLI/runtime to resolve them only adds startup cost. Plugin-provided node
  // subcommands (e.g. `nodes canvas`) are not registered above, so only pay the plugin load when
  // the invoked subcommand is not already a built-in.
  if (!shouldRegisterNodesPluginCommands(nodes, argv)) {
    return;
  }
  const { registerPluginCliCommandsFromValidatedConfig } = await import("../../plugins/cli.js");
  await withConsoleLogsRoutedToStderrForJson(
    argv,
    async () =>
      await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
        mode: "lazy",
        primary: "nodes",
      }),
  );
}

/** Plugin node subcommands are only resolved when the invocation is not a built-in nodes command. */
function shouldRegisterNodesPluginCommands(nodes: Command, argv: readonly string[]): boolean {
  const { commandPath } = resolveCliArgvInvocation([...argv]);
  if (commandPath[0] !== "nodes") {
    // Eager registration (root help/completion) needs the full command tree, plugins included.
    return true;
  }
  const requestedSubcommand = commandPath[1];
  if (!requestedSubcommand) {
    // Bare `openclaw nodes` listing should still surface plugin-provided subcommands.
    return true;
  }
  const builtInSubcommands = new Set(nodes.commands.map((command) => command.name()));
  return !builtInSubcommands.has(requestedSubcommand);
}
