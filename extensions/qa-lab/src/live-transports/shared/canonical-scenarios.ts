// Qa Lab plugin module defines canonical live-transport scenario delegation.
import path from "node:path";
import type { QaGatewayChildCommand } from "../../gateway-child.js";
import type { QaTransportAdapterFactory } from "../../qa-transport-registry.js";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import { runQaFlowSuiteFromRuntime } from "../../suite-launch.runtime.js";
import type { LiveTransportQaCommandOptions } from "./live-transport-cli.js";

export const TELEGRAM_CANONICAL_SCENARIO_IDS = [
  "channel-canary",
  "channel-mention-gating",
  "telegram-help-command",
  "telegram-commands-command",
  "telegram-tools-compact-command",
  "telegram-whoami-command",
  "telegram-status-command",
  "telegram-repeated-command-authorization",
  "telegram-context-command",
  "telegram-current-session-status-tool",
  "telegram-tool-only-usage-footer",
  "telegram-reply-chain-exact-marker",
] as const;

export const TELEGRAM_DEFAULT_CANONICAL_SCENARIO_IDS = [
  "channel-canary",
  "channel-mention-gating",
  "telegram-help-command",
  "telegram-commands-command",
  "telegram-tools-compact-command",
  "telegram-whoami-command",
  "telegram-status-command",
  "telegram-repeated-command-authorization",
  "telegram-context-command",
] as const;

export const WHATSAPP_ROUTING_CANONICAL_SCENARIO_IDS = [
  "channel-canary",
  "channel-dm-group-routing",
  "channel-mention-gating",
  "channel-top-level-reply-shape",
] as const;

export const WHATSAPP_CANONICAL_SCENARIO_IDS = [
  ...WHATSAPP_ROUTING_CANONICAL_SCENARIO_IDS,
  "whatsapp-help-command",
  "whatsapp-status-command",
  "whatsapp-commands-command",
  "whatsapp-tools-compact-command",
  "whatsapp-whoami-command",
  "whatsapp-context-command",
  "whatsapp-tool-only-usage-footer",
  "whatsapp-native-new-command",
] as const;

export const WHATSAPP_LIVE_DEFAULT_CANONICAL_SCENARIO_IDS = ["whatsapp-help-command"] as const;

export const WHATSAPP_MOCK_DEFAULT_CANONICAL_SCENARIO_IDS = [
  "whatsapp-help-command",
  "whatsapp-commands-command",
  "whatsapp-tools-compact-command",
  "whatsapp-whoami-command",
  "whatsapp-context-command",
  "whatsapp-tool-only-usage-footer",
  "whatsapp-native-new-command",
] as const;

export function whatsappDefaultCanonicalScenarioIds(providerMode: string) {
  return providerMode === "mock-openai"
    ? [...WHATSAPP_MOCK_DEFAULT_CANONICAL_SCENARIO_IDS]
    : [...WHATSAPP_LIVE_DEFAULT_CANONICAL_SCENARIO_IDS];
}

type CanonicalScenarioPartition = {
  canonical: string[];
  legacy: string[];
};

export function assertKnownScenarioIds(params: {
  ids: readonly string[];
  knownIds: readonly string[];
  laneLabel: string;
}) {
  const knownIds = new Set(params.knownIds);
  const missingIds = params.ids.filter((id) => !knownIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`unknown ${params.laneLabel} QA scenario id(s): ${missingIds.join(", ")}`);
  }
}

export function partitionCanonicalScenarioIds(
  scenarioIds: readonly string[] | undefined,
  canonicalIds: readonly string[],
): CanonicalScenarioPartition {
  const canonicalSet = new Set(canonicalIds);
  const canonical: string[] = [];
  const legacy: string[] = [];
  for (const scenarioId of scenarioIds ?? []) {
    (canonicalSet.has(scenarioId) ? canonical : legacy).push(scenarioId);
  }
  return { canonical, legacy };
}

export function listCanonicalScenarios(params: {
  ids: readonly string[];
  defaultIds: readonly string[];
}) {
  const requestedIds = new Set(params.ids);
  const defaultIds = new Set(params.defaultIds);
  return readQaScenarioPack()
    .scenarios.filter((scenario) => requestedIds.has(scenario.id))
    .map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      rationale: scenario.objective,
      regressionRefs: scenario.regressionRefs ?? [],
      defaultEnabled: defaultIds.has(scenario.id),
    }));
}

export async function runCanonicalLiveScenarios(params: {
  channelId: string;
  factory: QaTransportAdapterFactory;
  options: LiveTransportQaCommandOptions & {
    providerMode: "mock-openai" | "aimock" | "live-frontier";
    repoRoot: string;
    sutOpenClawCommand?: QaGatewayChildCommand;
  };
  scenarioIds: string[];
}) {
  return await runQaFlowSuiteFromRuntime({
    adapterFactories: [params.factory],
    adapterOptions: {
      repoRoot: params.options.repoRoot,
      ...(params.options.credentialRole ? { credentialRole: params.options.credentialRole } : {}),
      ...(params.options.credentialSource
        ? { credentialSource: params.options.credentialSource }
        : {}),
      ...(params.options.sutAccountId ? { sutAccountId: params.options.sutAccountId } : {}),
    },
    ...(params.options.alternateModel ? { alternateModel: params.options.alternateModel } : {}),
    channelDriver: "live",
    channelId: params.channelId,
    concurrency: 1,
    ...(params.options.fastMode !== undefined ? { fastMode: params.options.fastMode } : {}),
    ...(params.options.outputDir ? { outputDir: params.options.outputDir } : {}),
    ...(params.options.primaryModel ? { primaryModel: params.options.primaryModel } : {}),
    providerMode: params.options.providerMode,
    repoRoot: params.options.repoRoot,
    scenarioIds: params.scenarioIds,
    ...(params.options.sutOpenClawCommand
      ? { sutOpenClawCommand: params.options.sutOpenClawCommand }
      : {}),
  });
}

export function canonicalScenarioOutputDir(
  options: LiveTransportQaCommandOptions,
  includesLegacyRun: boolean,
) {
  return includesLegacyRun && options.outputDir
    ? path.join(options.outputDir, "canonical")
    : options.outputDir;
}
