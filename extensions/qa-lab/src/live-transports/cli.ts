import { listQaRunnerCliContributions } from "openclaw/plugin-sdk/qa-runner-runtime";
import { discordQaCliRegistration } from "./discord/cli.js";
import type { LiveTransportQaCliRegistration } from "./shared/live-transport-cli.js";
import { telegramQaCliRegistration } from "./telegram/cli.js";

function createBlockedQaRunnerCliRegistration(params: {
  commandName: string;
  description?: string;
  pluginId: string;
}): LiveTransportQaCliRegistration {
  return {
    commandName: params.commandName,
    register(qa) {
      qa.command(params.commandName)
        .description(params.description ?? `Run the ${params.commandName} live QA lane`)
        .action(() => {
          throw new Error(
            `QA runner "${params.commandName}" is installed but not active. Enable or allow plugin "${params.pluginId}" in your OpenClaw config, then try again.`,
          );
        });
    },
  };
}

function createQaRunnerCliRegistration(
  runner: ReturnType<typeof listQaRunnerCliContributions>[number],
): LiveTransportQaCliRegistration {
  if (runner.status === "available") {
    return runner.registration;
  }
  return createBlockedQaRunnerCliRegistration({
    commandName: runner.commandName,
    description: runner.description,
    pluginId: runner.pluginId,
  });
}

export const LIVE_TRANSPORT_QA_CLI_REGISTRATIONS: readonly LiveTransportQaCliRegistration[] = [
  telegramQaCliRegistration,
  discordQaCliRegistration,
];

export function listLiveTransportQaCliRegistrations(): readonly LiveTransportQaCliRegistration[] {
  const liveRegistrations = [...LIVE_TRANSPORT_QA_CLI_REGISTRATIONS];
  const discoveredRunners = listQaRunnerCliContributions();

  for (const runner of discoveredRunners) {
    liveRegistrations.push(createQaRunnerCliRegistration(runner));
  }

  return liveRegistrations;
}
