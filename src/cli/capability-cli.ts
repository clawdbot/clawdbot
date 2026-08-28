// Capability CLI command registration. Domain implementations live in ./capability-cli/.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { CAPABILITY_METADATA, findCapabilityMetadata } from "./capability-cli/metadata.js";
import { emitJsonOrText, providerSummaryText } from "./capability-cli/shared.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { removeCommandByName } from "./program/command-tree.js";

const capabilityCommandGroups = [
  [
    "model",
    async () => (await import("./capability-cli/model.js")).registerModelCapabilityCommands,
  ],
  [
    "image",
    async () => (await import("./capability-cli/image.js")).registerImageCapabilityCommands,
  ],
  [
    "audio",
    async () => (await import("./capability-cli/audio.js")).registerAudioCapabilityCommands,
  ],
  ["tts", async () => (await import("./capability-cli/tts.js")).registerTtsCapabilityCommands],
  [
    "video",
    async () => (await import("./capability-cli/video.js")).registerVideoCapabilityCommands,
  ],
  ["web", async () => (await import("./capability-cli/web.js")).registerWebCapabilityCommands],
  [
    "embedding",
    async () => (await import("./capability-cli/embedding.js")).registerEmbeddingCapabilityCommands,
  ],
] as const;

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

async function registerCapabilityDomainCommands(
  capability: Command,
  argv: string[],
): Promise<void> {
  const invocation = resolveCliArgvInvocation(argv);
  if (!invocation.hasHelpOrVersion) {
    const selectedName = invocation.commandPath[1];
    if (selectedName === "list" || selectedName === "inspect") {
      return;
    }
    const selected = capabilityCommandGroups.find(([name]) => name === selectedName);
    if (selected) {
      const register = await selected[1]();
      register(capability);
      return;
    }
  }

  const registrars = await Promise.all(capabilityCommandGroups.map(([, load]) => load()));
  for (const register of registrars) {
    register(capability);
  }
}

export async function registerCapabilityCli(
  program: Command,
  argv: string[] = process.argv,
): Promise<void> {
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
  await registerCapabilityDomainCommands(capability, argv);
}
