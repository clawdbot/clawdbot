import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "./cli-paths.js";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import type { QaProviderMode } from "./model-selection.js";
import { getQaProvider } from "./providers/index.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";

const DEFAULT_QA_SUITE_CONCURRENCY = 64;
const DEFAULT_QA_SUITE_WORKER_START_STAGGER_MS = 1_500;
const QA_MERGE_PATCH_BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type QaSeedScenario = ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];

function splitModelRef(ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return {
    provider: ref.slice(0, slash),
    model: ref.slice(slash + 1),
  };
}

function normalizeQaConfigString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scenarioMatchesLiveLane(params: {
  scenario: QaSeedScenario;
  primaryModel: string;
  providerMode: QaProviderMode;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const config = params.scenario.execution.config ?? {};
  const requiredProviderMode = normalizeQaConfigString(config.requiredProviderMode);
  if (requiredProviderMode && params.providerMode !== requiredProviderMode) {
    return false;
  }
  if (getQaProvider(params.providerMode).kind !== "live") {
    return true;
  }
  const selected = splitModelRef(params.primaryModel);
  const requiredProvider = normalizeQaConfigString(config.requiredProvider);
  if (requiredProvider && selected?.provider !== requiredProvider) {
    return false;
  }
  const requiredModel = normalizeQaConfigString(config.requiredModel);
  if (requiredModel && selected?.model !== requiredModel) {
    return false;
  }
  const requiredAuthMode = normalizeQaConfigString(config.authMode);
  if (requiredAuthMode && params.claudeCliAuthMode !== requiredAuthMode) {
    return false;
  }
  return true;
}

function selectQaSuiteScenarios(params: {
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
  scenarioIds?: string[];
  providerMode: QaProviderMode;
  primaryModel: string;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const requestedScenarioIds =
    params.scenarioIds && params.scenarioIds.length > 0 ? new Set(params.scenarioIds) : null;
  const requestedScenarios = requestedScenarioIds
    ? params.scenarios.filter((scenario) => requestedScenarioIds.has(scenario.id))
    : params.scenarios;
  if (requestedScenarioIds) {
    const foundScenarioIds = new Set(requestedScenarios.map((scenario) => scenario.id));
    const missingScenarioIds = [...requestedScenarioIds].filter(
      (scenarioId) => !foundScenarioIds.has(scenarioId),
    );
    if (missingScenarioIds.length > 0) {
      throw new Error(`unknown QA scenario id(s): ${missingScenarioIds.join(", ")}`);
    }
    return requestedScenarios;
  }
  return requestedScenarios.filter((scenario) =>
    scenarioMatchesLiveLane({
      scenario,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      claudeCliAuthMode: params.claudeCliAuthMode,
    }),
  );
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

function isQaPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function applyQaMergePatch(base: unknown, patch: unknown): unknown {
  if (!isQaPlainObject(patch)) {
    return patch;
  }
  const result = isQaPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (QA_MERGE_PATCH_BLOCKED_KEYS.has(key)) {
      continue;
    }
    if (value === null) {
      delete result[key];
      continue;
    }
    result[key] = isQaPlainObject(value) ? applyQaMergePatch(result[key], value) : value;
  }
  return result;
}

function collectQaSuiteGatewayConfigPatch(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const scenario of scenarios) {
    if (!isQaPlainObject(scenario.gatewayConfigPatch)) {
      continue;
    }
    merged = applyQaMergePatch(merged ?? {}, scenario.gatewayConfigPatch) as Record<
      string,
      unknown
    >;
  }
  return merged;
}

function collectQaSuiteGatewayRuntimeOptions(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
) {
  let forwardHostHome = false;
  for (const scenario of scenarios) {
    if (scenario.gatewayRuntime?.forwardHostHome === true) {
      forwardHostHome = true;
    }
  }
  return forwardHostHome ? { forwardHostHome: true } : undefined;
}

function scenarioRequiresControlUi(scenario: QaSeedScenario) {
  return normalizeLowercaseStringOrEmpty(scenario.surface) === "control-ui";
}

function normalizeQaSuiteConcurrency(
  value: number | undefined,
  scenarioCount: number,
  defaultConcurrency = DEFAULT_QA_SUITE_CONCURRENCY,
) {
  const envValue = Number(process.env.OPENCLAW_QA_SUITE_CONCURRENCY);
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : Number.isFinite(envValue)
        ? envValue
        : defaultConcurrency;
  return Math.max(1, Math.min(Math.floor(raw), Math.max(1, scenarioCount)));
}

function resolveQaSuiteWorkerStartStaggerMs(
  concurrency: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (concurrency <= 1) {
    return 0;
  }
  const raw = env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS;
  if (raw === undefined) {
    return DEFAULT_QA_SUITE_WORKER_START_STAGGER_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_QA_SUITE_WORKER_START_STAGGER_MS;
  }
  return Math.floor(parsed);
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
    opts?.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
    ? path.join(repoRoot, ".artifacts", "qa-e2e", `suite-${Date.now().toString(36)}`)
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
  collectQaSuitePluginIds,
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteWorkerStartStaggerMs,
  resolveQaSuiteOutputDir,
  scenarioRequiresControlUi,
  selectQaSuiteScenarios,
  splitModelRef,
};
