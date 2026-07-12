// Qa Lab plugin module implements suite planning behavior.
import path from "node:path";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createQaArtifactRunId } from "./artifact-run-id.js";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "./cli-paths.js";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import { splitQaModelRef as splitModelRef, type QaProviderMode } from "./model-selection.js";
import { getQaProvider } from "./providers/index.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";
import { applyQaMergePatch, isQaMergePatchObject } from "./suite-merge-patch.js";

const DEFAULT_QA_SUITE_CONCURRENCY = 64;
const DEFAULT_QA_SUITE_WORKER_START_STAGGER_MS = 1_500;
const QA_IMPLICIT_ISOLATION_FLOW_CALLS = new Set([
  "ensureImageGenerationConfigured",
  "forceMemoryIndex",
  "patchConfig",
  "writeWorkspaceSkill",
]);

type QaSeedScenario = ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];

function normalizeQaConfigString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function describeQaProviderLaneMismatches(params: {
  scenario: QaSeedScenario;
  primaryModel: string;
  providerMode: QaProviderMode;
  channelDriver?: QaScorecardChannelDriver | null;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const mismatches: string[] = [];
  const provider = getQaProvider(params.providerMode);
  if (params.scenario.runtimeParityTier === "live-only" && provider.kind !== "live") {
    mismatches.push("live provider mode");
  }
  const config = params.scenario.execution.config ?? {};
  const requiredProviderMode = normalizeQaConfigString(config.requiredProviderMode);
  if (requiredProviderMode && params.providerMode !== requiredProviderMode) {
    mismatches.push(`providerMode=${requiredProviderMode}`);
  }
  const requiredChannelDriver = normalizeQaConfigString(config.requiredChannelDriver);
  const effectiveChannelDriver = params.channelDriver ?? "qa-channel";
  if (requiredChannelDriver && effectiveChannelDriver !== requiredChannelDriver) {
    mismatches.push(`channelDriver=${requiredChannelDriver}`);
  }
  if (provider.kind !== "live") {
    return mismatches;
  }
  const selected = splitModelRef(params.primaryModel);
  const requiredProvider = normalizeQaConfigString(config.requiredProvider);
  if (requiredProvider && selected?.provider !== requiredProvider) {
    mismatches.push(`provider=${requiredProvider}`);
  }
  const requiredModel = normalizeQaConfigString(config.requiredModel);
  if (requiredModel && selected?.model !== requiredModel) {
    mismatches.push(`model=${requiredModel}`);
  }
  const requiredAuthMode = normalizeQaConfigString(config.authMode);
  if (requiredAuthMode && params.claudeCliAuthMode !== requiredAuthMode) {
    mismatches.push(`authMode=${requiredAuthMode}`);
  }
  return mismatches;
}

function scenarioMatchesQaProviderLane(params: {
  scenario: QaSeedScenario;
  primaryModel: string;
  providerMode: QaProviderMode;
  channelDriver?: QaScorecardChannelDriver | null;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  return describeQaProviderLaneMismatches(params).length === 0;
}

function selectQaFlowSuiteScenarios(params: {
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
  scenarioIds?: string[];
  providerMode: QaProviderMode;
  primaryModel: string;
  channelDriver?: QaScorecardChannelDriver | null;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const requestedScenarioIds =
    params.scenarioIds && params.scenarioIds.length > 0 ? new Set(params.scenarioIds) : null;
  if (requestedScenarioIds) {
    const scenarioById = new Map(params.scenarios.map((scenario) => [scenario.id, scenario]));
    const missingScenarioIds = [...requestedScenarioIds].filter(
      (scenarioId) => !scenarioById.has(scenarioId),
    );
    if (missingScenarioIds.length > 0) {
      throw new Error(`unknown QA scenario id(s): ${missingScenarioIds.join(", ")}`);
    }
    const selectedScenarios = [...requestedScenarioIds].map(
      (scenarioId) => scenarioById.get(scenarioId)!,
    );
    const nonFlowScenarios = selectedScenarios.filter(
      (scenario) => scenario.execution.kind !== "flow",
    );
    if (nonFlowScenarios.length > 0) {
      const scenarioList = nonFlowScenarios
        .map((scenario) => `${scenario.id} (${scenario.execution.kind})`)
        .join(", ");
      throw new Error(
        `flow execution requires execution.kind: flow; unsupported scenario(s): ${scenarioList}`,
      );
    }
    const channelDriverMismatches = selectedScenarios.flatMap((scenario) => {
      const mismatches = describeQaProviderLaneMismatches({
        scenario,
        providerMode: params.providerMode,
        primaryModel: params.primaryModel,
        channelDriver: params.channelDriver,
        claudeCliAuthMode: params.claudeCliAuthMode,
      }).filter((mismatch) => mismatch.startsWith("channelDriver="));
      return mismatches.length > 0 ? [`${scenario.id} (${mismatches.join(", ")})`] : [];
    });
    if (channelDriverMismatches.length > 0) {
      throw new Error(
        `selected QA scenario(s) do not match the current QA lane: ${channelDriverMismatches.join(", ")}`,
      );
    }
    return selectedScenarios;
  }
  return params.scenarios.filter(
    (scenario) =>
      scenario.execution.kind === "flow" &&
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: params.providerMode,
        primaryModel: params.primaryModel,
        channelDriver: params.channelDriver,
        claudeCliAuthMode: params.claudeCliAuthMode,
      }),
  );
}

function normalizeQaSuiteScenarioChannel(scenario: QaSeedScenario) {
  return scenario.execution.channel?.trim().toLowerCase() || undefined;
}

function listQaSuiteScenarioChannels(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
) {
  return [
    ...new Set(
      scenarios
        .map(normalizeQaSuiteScenarioChannel)
        .filter((channel): channel is string => Boolean(channel)),
    ),
  ];
}

function resolveQaSuiteScenarioChannel(params: {
  defaultChannel: string;
  explicitChannel?: string | null;
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
}) {
  const scenarioChannels = resolveQaSuiteScenarioChannels(params);
  const [scenarioChannel] = scenarioChannels;
  if (scenarioChannels.length === 1 && scenarioChannel) {
    return scenarioChannel;
  }
  throw new Error(
    `Selected QA scenarios require multiple channels (${scenarioChannels.join(", ")}); split the run by channel.`,
  );
}

function resolveQaSuiteScenarioChannels(params: {
  defaultChannel: string;
  explicitChannel?: string | null;
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
}) {
  const scenarioChannels = listQaSuiteScenarioChannels(params.scenarios);
  const explicitChannel = params.explicitChannel?.trim().toLowerCase();
  if (explicitChannel) {
    const conflictingChannels = scenarioChannels.filter((channel) => channel !== explicitChannel);
    if (conflictingChannels.length > 0) {
      throw new Error(
        `--channel ${explicitChannel} conflicts with selected scenario execution.channel ${conflictingChannels.join(", ")}.`,
      );
    }
    return [explicitChannel];
  }
  if (scenarioChannels.length === 0) {
    return [params.defaultChannel];
  }
  if (scenarioChannels.length === 1) {
    return scenarioChannels;
  }
  const hasUnpinnedScenario = params.scenarios.some(
    (scenario) => !normalizeQaSuiteScenarioChannel(scenario),
  );
  return hasUnpinnedScenario && !scenarioChannels.includes(params.defaultChannel)
    ? [params.defaultChannel, ...scenarioChannels]
    : scenarioChannels;
}

function collectQaSuitePluginIds(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
) {
  return [
    ...new Set(
      scenarios.flatMap((scenario) =>
        Array.isArray(scenario.plugins)
          ? scenario.plugins
              .map((pluginId) => pluginId.trim())
              .filter((pluginId) => pluginId.length > 0)
          : [],
      ),
    ),
  ];
}

const QA_GATEWAY_CONFIG_SELECTED_ACCOUNT_KEY = "$selectedAccount";

// Scenario patches resolve this reserved object key against the adapter's selected account before
// merging, so CLI account overrides cannot leave configuration on an inactive default account.
function resolveQaGatewayConfigPatchSelectedAccount(
  patch: unknown,
  selectedAccountId: string,
): unknown {
  if (Array.isArray(patch)) {
    return patch.map((entry) =>
      resolveQaGatewayConfigPatchSelectedAccount(entry, selectedAccountId),
    );
  }
  if (!isQaMergePatchObject(patch)) {
    return patch;
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const resolvedKey = key === QA_GATEWAY_CONFIG_SELECTED_ACCOUNT_KEY ? selectedAccountId : key;
    Object.defineProperty(resolved, resolvedKey, {
      configurable: true,
      enumerable: true,
      value: resolveQaGatewayConfigPatchSelectedAccount(value, selectedAccountId),
      writable: true,
    });
  }
  return resolved;
}

function collectQaSuiteGatewayConfigPatch(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
  selectedAccountId = "sut",
): Record<string, unknown> | undefined {
  const resolvedSelectedAccountId = selectedAccountId.trim() || "sut";
  let merged: Record<string, unknown> | undefined;
  for (const scenario of scenarios) {
    if (!isQaMergePatchObject(scenario.gatewayConfigPatch)) {
      continue;
    }
    const resolvedPatch = resolveQaGatewayConfigPatchSelectedAccount(
      scenario.gatewayConfigPatch,
      resolvedSelectedAccountId,
    );
    merged = applyQaMergePatch(merged ?? {}, resolvedPatch) as Record<string, unknown>;
  }
  return merged;
}

function collectQaSuiteGatewayRuntimeOptions(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
) {
  let forwardHostHome = false;
  let preserveDebugArtifacts = false;
  for (const scenario of scenarios) {
    if (scenario.gatewayRuntime?.forwardHostHome === true) {
      forwardHostHome = true;
    }
    if (scenario.gatewayRuntime?.preserveDebugArtifacts === true) {
      preserveDebugArtifacts = true;
    }
  }
  return forwardHostHome || preserveDebugArtifacts
    ? {
        ...(forwardHostHome ? { forwardHostHome: true } : {}),
        ...(preserveDebugArtifacts ? { preserveDebugArtifacts: true } : {}),
      }
    : undefined;
}

function collectQaSuiteTransportPolicy(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
) {
  let requireGroupMention = false;
  let topLevelReplies = false;
  let senderAllowlist: readonly string[] | undefined;
  for (const scenario of scenarios) {
    if (scenario.execution.kind !== "flow") {
      continue;
    }
    const policy = scenario.execution.transportPolicy;
    requireGroupMention ||= policy?.requireGroupMention === true;
    topLevelReplies ||= policy?.topLevelReplies === true;
    if (!policy?.senderAllowlist) {
      continue;
    }
    if (
      senderAllowlist &&
      JSON.stringify(senderAllowlist) !== JSON.stringify(policy.senderAllowlist)
    ) {
      throw new Error("Selected QA scenarios require conflicting transport sender allowlists.");
    }
    senderAllowlist = policy.senderAllowlist;
  }
  return requireGroupMention || topLevelReplies || senderAllowlist
    ? {
        ...(requireGroupMention ? { requireGroupMention: true as const } : {}),
        ...(senderAllowlist ? { senderAllowlist } : {}),
        ...(topLevelReplies ? { topLevelReplies: true as const } : {}),
      }
    : undefined;
}

function shouldUseIsolatedQaSuiteScenarioWorkers(params: {
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
  concurrency: number;
}) {
  return (
    params.scenarios.length > 1 &&
    (params.concurrency > 1 ||
      params.scenarios.some(
        (scenario) =>
          isQaMergePatchObject(scenario.gatewayConfigPatch) ||
          (scenario.execution.kind === "flow" && scenario.execution.transportPolicy !== undefined),
      ))
  );
}

function scenarioRequiresIsolatedQaSuiteWorker(scenario: QaSeedScenario) {
  if (scenario.execution.kind !== "flow") {
    return false;
  }
  return (
    scenario.execution.suiteIsolation === "isolated" ||
    // Transport policy is fixed when the gateway starts; sharing it would leak routing rules.
    scenario.execution.transportPolicy !== undefined ||
    isQaMergePatchObject(scenario.gatewayConfigPatch) ||
    scenario.gatewayRuntime !== undefined ||
    (Array.isArray(scenario.plugins) && scenario.plugins.length > 0) ||
    normalizeLowercaseStringOrEmpty(scenario.surface) === "memory" ||
    scenario.execution.config?.ensureImageGeneration === true ||
    flowContainsImplicitIsolationCall(scenario.execution.flow)
  );
}

function flowContainsImplicitIsolationCall(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(flowContainsImplicitIsolationCall);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.call === "string" && QA_IMPLICIT_ISOLATION_FLOW_CALLS.has(record.call)) {
    return true;
  }
  return Object.values(record).some(flowContainsImplicitIsolationCall);
}

function scenarioRequiresControlUi(scenario: QaSeedScenario) {
  return normalizeLowercaseStringOrEmpty(scenario.surface) === "control-ui";
}

function normalizeQaSuiteConcurrency(
  value: number | undefined,
  scenarioCount: number,
  defaultConcurrency = DEFAULT_QA_SUITE_CONCURRENCY,
) {
  const envValue = parseStrictNonNegativeInteger(process.env.OPENCLAW_QA_SUITE_CONCURRENCY);
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : envValue !== undefined
        ? envValue
        : defaultConcurrency;
  return Math.max(1, Math.min(Math.floor(raw), Math.max(1, scenarioCount)));
}

function resolveQaSuiteWorkerStartStaggerMs(
  concurrency: number,
  env: NodeJS.ProcessEnv = process.env,
  defaultStaggerMs = DEFAULT_QA_SUITE_WORKER_START_STAGGER_MS,
) {
  if (concurrency <= 1) {
    return 0;
  }
  const raw = env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS;
  if (raw === undefined) {
    return defaultStaggerMs;
  }
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed === undefined) {
    return defaultStaggerMs;
  }
  return parsed;
}

async function mapQaSuiteWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
  opts?: {
    startStaggerMs?: number;
    sleepImpl?: (ms: number) => Promise<unknown>;
  },
) {
  const results = Array.from<U>({ length: items.length });
  let nextIndex = 0;
  let nextStartGate = Promise.resolve();
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  const startStaggerMs = Math.max(0, Math.floor(opts?.startStaggerMs ?? 0));
  const sleepImpl =
    opts?.sleepImpl ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  async function waitForStartSlot(shouldReleaseNextSlot: boolean) {
    const currentGate = nextStartGate;
    let releaseNextSlot: (() => void) | undefined;
    if (shouldReleaseNextSlot) {
      nextStartGate = new Promise<void>((resolve) => {
        releaseNextSlot = resolve;
      });
    }
    await currentGate;
    if (!releaseNextSlot) {
      return;
    }
    void (async () => {
      try {
        if (startStaggerMs > 0) {
          await sleepImpl(startStaggerMs);
        }
      } finally {
        releaseNextSlot();
      }
    })();
  }
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await waitForStartSlot(nextIndex < items.length);
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveQaSuiteOutputDir(repoRoot: string, outputDir?: string) {
  const targetDir = !outputDir
    ? path.join(repoRoot, ".artifacts", "qa-e2e", `suite-${createQaArtifactRunId()}`)
    : outputDir;
  if (!path.isAbsolute(targetDir)) {
    const resolved = resolveRepoRelativeOutputDir(repoRoot, targetDir);
    if (!resolved) {
      throw new Error("QA suite outputDir must be set.");
    }
    return await ensureRepoBoundDirectory(repoRoot, resolved, "QA suite outputDir", {
      mode: 0o700,
    });
  }
  return await ensureRepoBoundDirectory(repoRoot, targetDir, "QA suite outputDir", {
    mode: 0o700,
  });
}

export {
  applyQaMergePatch,
  collectQaSuiteGatewayConfigPatch,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuiteTransportPolicy,
  collectQaSuitePluginIds,
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  normalizeQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  resolveQaSuiteWorkerStartStaggerMs,
  resolveQaSuiteOutputDir,
  scenarioRequiresControlUi,
  scenarioRequiresIsolatedQaSuiteWorker,
  scenarioMatchesQaProviderLane,
  selectQaFlowSuiteScenarios,
  shouldUseIsolatedQaSuiteScenarioWorkers,
  splitModelRef,
};
