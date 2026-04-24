import type { Command } from "commander";
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";

type DiscordQaCliRuntime = typeof import("./cli.runtime.js");

const loadDiscordQaCliRuntime = createLazyCliRuntimeLoader<DiscordQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runQaDiscord(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadDiscordQaCliRuntime();
  await runtime.runQaDiscordCommand(opts);
}

export const discordQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "discord",
    credentialOptions: {
      sourceDescription: "Credential source for Discord QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run the Discord live QA lane against a private guild bot-to-bot harness",
    outputDirHelp: "Discord QA artifact directory",
    scenarioHelp: "Run only the named Discord QA scenario (repeatable)",
    sutAccountHelp: "Temporary Discord account id inside the QA gateway config",
    run: runQaDiscord,
  });

export function registerDiscordQaCli(qa: Command) {
  discordQaCliRegistration.register(qa);
}
