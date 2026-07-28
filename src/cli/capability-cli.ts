// Capability CLI command registration. Domain implementations live in ./capability-cli/.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../runtime.js";
import { registerAudioCapabilityCommands } from "./capability-cli/audio.js";
import { registerEmbeddingCapabilityCommands } from "./capability-cli/embedding.js";
import { registerImageCapabilityCommands } from "./capability-cli/image.js";
import { CAPABILITY_METADATA, findCapabilityMetadata } from "./capability-cli/metadata.js";
import { registerModelCapabilityCommands } from "./capability-cli/model.js";
import { emitJsonOrText, providerSummaryText } from "./capability-cli/shared.js";
import { registerTtsCapabilityCommands } from "./capability-cli/tts.js";
import { registerVideoCapabilityCommands } from "./capability-cli/video.js";
import { registerWebCapabilityCommands } from "./capability-cli/web.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { removeCommandByName } from "./program/command-tree.js";

export { CAPABILITY_METADATA } from "./capability-cli/metadata.js";

function registerCapabilityListAndInspect(capability: Command): void {
  capability
    .command("list")
    .description("List canonical capability ids and supported transports")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = CAPABILITY_METADATA.map((entry) => ({
          id: entry.id,
          transports: entry.transports,
          description: entry.description,
        }));
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });

  capability
    .command("inspect")
    .description("Inspect one canonical capability id")
    .requiredOption("--name <capability>", "Capability id")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const entry = findCapabilityMetadata(String(opts.name));
        if (!entry) {
          throw new Error(`Unknown capability: ${String(opts.name)}`);
        }
        emitJsonOrText(defaultRuntime, Boolean(opts.json), entry, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });
}

export function registerCapabilityCli(program: Command): void {
  removeCommandByName(program, "infer");
  removeCommandByName(program, "capability");

  const capability = program
    .command("infer")
    .alias("capability")
    .description("Run provider-backed inference commands through a stable CLI surface")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/infer", "docs.openclaw.ai/cli/infer")}\n`,
    );

  registerCapabilityListAndInspect(capability);
  registerModelCapabilityCommands(capability);
  registerImageCapabilityCommands(capability);
  registerAudioCapabilityCommands(capability);
  registerTtsCapabilityCommands(capability);
  registerVideoCapabilityCommands(capability);
  registerWebCapabilityCommands(capability);
  registerEmbeddingCapabilityCommands(capability);
}
