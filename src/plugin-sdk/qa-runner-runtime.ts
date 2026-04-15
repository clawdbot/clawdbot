import type { Command } from "commander";

export type QaRunnerCliRegistration = {
  commandName: string;
  register: (qa: Command) => void;
};

export type QaRunnerCliContribution =
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "blocked";
    }
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "available";
      registration: QaRunnerCliRegistration;
    };

const QA_RUNNER_CLI_REGISTRY_SYMBOL = Symbol.for("openclaw.qaRunnerCliContributionRegistry");

type QaRunnerRegistry = {
  values?: () => Iterable<QaRunnerCliContribution>;
  [Symbol.iterator]?: () => Iterator<QaRunnerCliContribution>;
};

function listRegistryValues(registry: QaRunnerRegistry): QaRunnerCliContribution[] {
  if (typeof registry.values === "function") {
    return [...registry.values()];
  }
  if (typeof registry[Symbol.iterator] === "function") {
    return [...registry];
  }
  return [];
}

export function listQaRunnerCliContributions(): QaRunnerCliContribution[] {
  const registry = (globalThis as Record<PropertyKey, unknown>)[QA_RUNNER_CLI_REGISTRY_SYMBOL] as
    | QaRunnerRegistry
    | undefined;
  if (!registry) {
    return [];
  }
  return listRegistryValues(registry);
}
