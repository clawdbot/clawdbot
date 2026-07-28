import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { buildQaCodexAppServerArgs } from "./codex-app-server-args.js";
import type { QaSuiteChannelDriverSelection } from "./crabline-artifacts.js";
import type { QaProviderMode } from "./model-selection.js";
import { parseQaProgressBooleanEnv as parseQaSuiteBooleanEnv } from "./progress-format.js";
import type { QaTransportId } from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import type { RuntimeId } from "./runtime-parity.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";
import { scenarioRequiresControlUi, splitModelRef } from "./suite-planning.js";
import type { QaSuiteRunParams, QaSuiteScenarioResult, QaSuiteStartLabFn } from "./suite-types.js";

type QaCrablineRuntime = typeof import("@openclaw/crabline");

/**
 * One bounded retry for live-model flake: flow scenarios time out under model
 * latency spikes, so a first failure gets a single rerun. A retry pass keeps
 * the first attempt visible in details; a retry failure keeps the original
 * diagnostics so deterministic regressions still fail the suite.
 */
export async function runQaScenarioWithFlakeRetry(
  run: () => Promise<QaSuiteScenarioResult>,
  onRetry?: () => void,
): Promise<QaSuiteScenarioResult> {
  const first = await run();
  if (first.status !== "fail") {
    return first;
  }
  onRetry?.();
  const second = await run();
  if (second.status !== "pass") {
    return first;
  }
  return {
    ...second,
    details: [second.details, `passed on retry; first attempt: ${first.details ?? "failed"}`]
      .filter(Boolean)
      .join(" | "),
  };
}

export function createQaSuiteReportNotes(params: {
  transport: QaTransportAdapter;
  channelDriverSelection?: QaSuiteChannelDriverSelection | null;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  isolatedWorkers?: boolean;
  createCrablineChannelReportNotes?: QaCrablineRuntime["createOpenClawCrablineChannelReportNotes"];
}) {
  return [
    ...params.transport.createReportNotes(params),
    // Crabline reports completed generation paths through this filename-narrowed selection.
    ...(params.createCrablineChannelReportNotes?.(
      params.channelDriverSelection as OpenClawCrablineChannelDriverSelection | null | undefined,
    ) ?? []),
  ];
}

export function buildQaIsolatedScenarioWorkerParams(params: {
  repoRoot: string;
  outputDir: string;
  providerMode: QaProviderMode;
  transportId: QaTransportId;
  channelDriver?: QaScorecardChannelDriver;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];
  input?: QaSuiteRunParams;
  startLab: QaSuiteStartLabFn;
}): QaSuiteRunParams {
  return {
    adapterFactories: params.input?.adapterFactories,
    adapterOptions: params.input?.adapterOptions,
    channelId: params.input?.channelId,
    repoRoot: params.repoRoot,
    sutOpenClawCommand: params.input?.sutOpenClawCommand,
    outputDir: params.outputDir,
    providerMode: params.providerMode,
    transportId: params.transportId,
    channelDriver: params.channelDriver,
    channelDriverSelection: params.channelDriverSelection,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    fastMode: params.fastMode,
    thinkingDefault: params.input?.thinkingDefault,
    claudeCliAuthMode: params.input?.claudeCliAuthMode,
    scenarioIds: [params.scenario.id],
    enabledPluginIds: params.input?.enabledPluginIds,
    concurrency: 1,
    startLab: params.startLab,
    controlUiEnabled: scenarioRequiresControlUi(params.scenario),
    transportReadyTimeoutMs: params.input?.transportReadyTimeoutMs,
    workerStartStaggerMs: params.input?.workerStartStaggerMs,
    forcedRuntime: params.input?.forcedRuntime,
    roundTripProbe:
      params.input?.roundTripProbe?.scenarioId === params.scenario.id
        ? params.input.roundTripProbe
        : undefined,
    writeEvidenceFile: params.input?.writeEvidenceFile,
  };
}

export function remapModelRefForForcedRuntime(params: {
  modelRef: string;
  providerMode: QaProviderMode;
  forcedRuntime?: RuntimeId;
}) {
  if (params.forcedRuntime !== "codex" || params.providerMode !== "mock-openai") {
    return params.modelRef;
  }
  const split = splitModelRef(params.modelRef);
  if (!split || split.provider !== "mock-openai") {
    return params.modelRef;
  }
  return `openai/${split.model}`;
}

export function buildQaRuntimeEnvPatch(params: {
  providerMode: QaProviderMode;
  forcedRuntime?: RuntimeId;
  mockBaseUrl?: string;
  nativeAppServerArgs?: string;
}): NodeJS.ProcessEnv | undefined {
  const patch: NodeJS.ProcessEnv = {};
  if (params.forcedRuntime) {
    patch.OPENCLAW_BUILD_PRIVATE_QA = "1";
    patch.OPENCLAW_QA_FORCE_RUNTIME = params.forcedRuntime;
  }
  if (params.forcedRuntime !== "codex") {
    return Object.keys(patch).length > 0 ? patch : undefined;
  }
  if (params.providerMode !== "mock-openai") {
    patch.OPENCLAW_CODEX_APP_SERVER_ARGS = buildQaCodexAppServerArgs({
      existingArgs: params.nativeAppServerArgs,
    });
    return patch;
  }
  let mockBaseUrl = params.mockBaseUrl?.trim();
  while (mockBaseUrl?.endsWith("/")) {
    mockBaseUrl = mockBaseUrl.slice(0, -1);
  }
  if (!mockBaseUrl) {
    return Object.keys(patch).length > 0 ? patch : undefined;
  }
  // The forced codex lane uses the Codex app-server's native OpenAI provider
  // path, so pin the managed app-server to the QA mock endpoint instead of
  // leaking to the maintainer's real OpenAI config.
  patch.OPENCLAW_CODEX_APP_SERVER_ARGS = buildQaCodexAppServerArgs({
    providerBaseUrl: `${mockBaseUrl}/v1`,
  });
  patch.OPENAI_API_KEY = "qa-mock-openai-key";
  patch.CODEX_API_KEY = "qa-mock-openai-key";
  return patch;
}

export function appendNodeOption(raw: string | undefined, option: string) {
  const parts = (raw ?? "").split(/\s+/u).filter(Boolean);
  return parts.includes(option) ? parts.join(" ") : [...parts, option].join(" ");
}

export function shouldCaptureGatewayHeapCheckpoints(env: NodeJS.ProcessEnv = process.env) {
  return parseQaSuiteBooleanEnv(env.OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS) === true;
}

export function buildQaGatewayHeapCheckpointRuntimeEnvPatch(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (!shouldCaptureGatewayHeapCheckpoints(env)) {
    return undefined;
  }
  return {
    NODE_OPTIONS: appendNodeOption(env.NODE_OPTIONS, "--heapsnapshot-signal=SIGUSR2"),
  };
}

export function mergeQaRuntimeEnvPatches(
  ...patches: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv | undefined {
  const merged: NodeJS.ProcessEnv = {};
  for (const patch of patches) {
    if (!patch) {
      continue;
    }
    Object.assign(merged, patch);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
