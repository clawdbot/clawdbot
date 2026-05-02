import { aimockProviderDefinition } from "./aimock/index.js";
import { liveFrontierProviderDefinition } from "./live-frontier/index.js";
import { mockOpenAiProviderDefinition } from "./mock-openai/index.js";
import type { QaProviderDefinition, QaProviderMode, QaProviderModeInput } from "./shared/types.js";

export type { QaMockProviderServer, QaProviderMode, QaProviderModeInput } from "./shared/types.js";

const PROVIDERS: readonly QaProviderDefinition[] = [
  mockOpenAiProviderDefinition,
  aimockProviderDefinition,
  liveFrontierProviderDefinition,
] as const;

export const DEFAULT_QA_PROVIDER_MODE: QaProviderMode = "mock-openai";
export const DEFAULT_QA_LIVE_PROVIDER_MODE: QaProviderMode = "live-frontier";

const PROVIDERS_BY_INPUT = new Map<QaProviderModeInput, QaProviderDefinition>();
for (const provider of PROVIDERS) {
  PROVIDERS_BY_INPUT.set(provider.mode, provider);
}

export function isQaProviderModeInput(input: unknown): input is QaProviderModeInput {
  return typeof input === "string" && PROVIDERS_BY_INPUT.has(input as QaProviderModeInput);
}

export function normalizeQaProviderMode(input: QaProviderModeInput): QaProviderMode {
  return getQaProvider(input).mode;
}

export function getQaProvider(input: QaProviderModeInput): QaProviderDefinition {
  const provider = PROVIDERS_BY_INPUT.get(input);
  if (!provider) {
    throw new Error(`unknown QA provider mode: ${input}`);
  }
  return provider;
}

function listQaProviderModes() {
  return PROVIDERS.map((provider) => provider.mode);
}

export function formatQaProviderModeHelp() {
  return `Provider mode: ${listQaProviderModes().join(", ")}`;
}

export function listQaStandaloneProviderCommands() {
  return PROVIDERS.flatMap((provider) =>
    provider.standaloneCommand
      ? [
          {
            providerMode: provider.mode,
            ...provider.standaloneCommand,
          },
        ]
      : [],
  );
}
