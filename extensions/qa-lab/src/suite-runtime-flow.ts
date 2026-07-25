// Qa Lab plugin module implements suite runtime flow behavior.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage as formatQaErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-host-core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  callQaBrowserRequest,
  qaBrowserAct,
  qaBrowserOpenTab,
  qaBrowserSnapshot,
  waitForQaBrowserReady,
} from "./browser-runtime.js";
import { waitForCronRunCompletion } from "./cron-run-wait.js";
import {
  hasDiscoveryLabels,
  reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles,
} from "./discovery-eval.js";
import { QaSuiteScenarioSkipError } from "./errors.js";
import { extractQaToolPayload } from "./extract-tool-payload.js";
import { assertNoGatewayLogSentinels, scanGatewayLogSentinels } from "./gateway-log-sentinel.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";
import { runRuntimeToolFixture } from "./runtime-tool-fixture.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { createQaScenarioRuntimeApi, type QaScenarioRuntimeEnv } from "./scenario-runtime-api.js";
import {
  callPluginToolsMcp,
  createSession,
  ensureImageGenerationConfigured,
  extractMediaPathFromText,
  findSkill,
  forceMemoryIndex,
  findManagedDreamingCronJob,
  handleQaAction,
  listCronJobs,
  readDoctorMemoryStatus,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
  resolveGeneratedImagePath,
  runAgentPrompt,
  runQaCli,
  seedQaSessionTranscript,
  startAgentRun,
  waitForAgentHistoryReply,
  waitForAgentRun,
  writeWorkspaceSkill,
} from "./suite-runtime-agent.js";
import {
  applyConfig,
  fetchJson,
  patchConfig,
  readConfigSnapshot,
  restartGatewayWithConfigPatch,
  waitForConfigRestartSettle,
  waitForGatewayHealthy,
  waitForQaChannelReady,
  waitForTransportReady,
} from "./suite-runtime-gateway.js";
import {
  formatConversationTranscript,
  formatTransportTranscript,
  readTransportTranscript,
  recentOutboundSummary,
  waitForChannelOutboundMessage,
  waitForNoOutbound,
  waitForNoTransportOutbound,
  waitForOutboundMessage,
  waitForTransportOutboundMessage,
} from "./suite-runtime-transport.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import {
  qaWebEvaluate,
  qaWebOpenPage,
  qaWebSnapshot,
  qaWebType,
  qaWebWait,
} from "./web-runtime.js";

type QaSuiteScenarioFlowEnv = {
  lab: unknown;
  webSessionIds: Set<string>;
  transport: QaSuiteRuntimeEnv["transport"] & QaScenarioRuntimeEnv["transport"];
} & Omit<QaSuiteRuntimeEnv, "transport">;

function activeMemoryToggleKey(sessionKey: string) {
  return createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function setActiveMemorySessionDisabled(
  env: QaSuiteScenarioFlowEnv,
  sessionKey: string,
  disabled: boolean,
) {
  const store = createPluginStateSyncKeyedStore<{
    sessionKey: string;
    disabled: true;
    updatedAt: number;
  }>("active-memory", {
    namespace: "session-toggles",
    maxEntries: 10_000,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(env.gateway.tempRoot, "state"),
    },
  });
  const key = activeMemoryToggleKey(sessionKey);
  if (disabled) {
    store.register(key, {
      sessionKey,
      disabled: true,
      updatedAt: Date.now(),
    });
    return;
  }
  store.delete(key);
}

type QaSuiteStep = {
  name: string;
  run: () => Promise<string | void>;
};

type QaSuiteScenarioResult = {
  name: string;
  status: "pass" | "fail" | "skip";
  steps: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
    details?: string;
  }>;
  details?: string;
};

export async function runQaSuiteScenarioSteps(
  name: string,
  steps: QaSuiteStep[],
): Promise<QaSuiteScenarioResult> {
  const stepResults: QaSuiteScenarioResult["steps"] = [];
  for (const step of steps) {
    try {
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] start scenario="${name}" step="${step.name}"`);
      }
      const details = await step.run();
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] pass scenario="${name}" step="${step.name}"`);
      }
      stepResults.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatQaErrorMessage(error);
      if (error instanceof QaSuiteScenarioSkipError) {
        stepResults.push({ name: step.name, status: "skip", details });
        return { name, status: "skip", steps: stepResults, details };
      }
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] fail scenario="${name}" step="${step.name}" details=${details}`);
      }
      stepResults.push({ name: step.name, status: "fail", details });
      return { name, status: "fail", steps: stepResults, details };
    }
  }
  return { name, status: "pass", steps: stepResults };
}

type QaSuiteScenarioDepsParams = {
  env: QaSuiteScenarioFlowEnv;
  runScenario: (name: string, steps: QaSuiteStep[]) => Promise<QaSuiteScenarioResult>;
  splitModelRef: (ref: string) => { provider: string; model: string } | null;
  formatErrorMessage: (error: unknown) => string;
  liveTurnTimeoutMs: (
    env: Pick<QaSuiteRuntimeEnv, "providerMode" | "primaryModel" | "alternateModel">,
    fallbackMs: number,
  ) => number;
  resolveQaLiveTurnTimeoutMs: (
    env: Pick<QaSuiteRuntimeEnv, "providerMode" | "primaryModel" | "alternateModel">,
    fallbackMs: number,
  ) => number;
};

type QaSuiteScenarioFlowApiParams = QaSuiteScenarioDepsParams & {
  scenario: QaSeedScenarioWithSource;
  constants: {
    imageUnderstandingPngBase64: string;
    imageUnderstandingLargePngBase64: string;
    imageUnderstandingValidPngBase64: string;
  };
};

function createQaSuiteScenarioDeps(params: QaSuiteScenarioDepsParams) {
  return {
    fs,
    path,
    sleep,
    randomUUID,
    runScenario: params.runScenario,
    waitForOutboundMessage,
    waitForTransportOutboundMessage,
    waitForChannelOutboundMessage,
    waitForNoOutbound,
    waitForNoTransportOutbound,
    recentOutboundSummary,
    formatConversationTranscript,
    readTransportTranscript,
    formatTransportTranscript,
    fetchJson,
    waitForGatewayHealthy,
    waitForTransportReady,
    waitForQaChannelReady,
    browserRequest: callQaBrowserRequest,
    waitForBrowserReady: waitForQaBrowserReady,
    browserOpenTab: qaBrowserOpenTab,
    browserSnapshot: qaBrowserSnapshot,
    browserAct: qaBrowserAct,
    webOpenPage: async (webParams: Parameters<typeof qaWebOpenPage>[0]) => {
      const opened = await qaWebOpenPage({ ...webParams, repoRoot: params.env.repoRoot });
      params.env.webSessionIds.add(opened.pageId);
      return opened;
    },
    webWait: qaWebWait,
    webType: qaWebType,
    webSnapshot: qaWebSnapshot,
    webEvaluate: qaWebEvaluate,
    waitForConfigRestartSettle,
    patchConfig,
    applyConfig,
    readConfigSnapshot,
    restartGatewayWithConfigPatch,
    createSession,
    readEffectiveTools,
    readSkillStatus,
    readRawQaSessionStore,
    seedQaSessionTranscript,
    readGatewayLogs: () => params.env.gateway.logs?.() ?? "",
    markGatewayLogCursor: () => (params.env.gateway.logs?.() ?? "").length,
    scanGatewayLogSentinels: (options?: Parameters<typeof scanGatewayLogSentinels>[1]) =>
      scanGatewayLogSentinels(params.env.gateway.logs?.(), options),
    assertNoGatewayLogSentinels: (options?: Parameters<typeof assertNoGatewayLogSentinels>[1]) =>
      assertNoGatewayLogSentinels(params.env.gateway.logs?.(), options),
    readSessionTranscriptSummary,
    runQaCli,
    extractMediaPathFromText,
    resolveGeneratedImagePath,
    startAgentRun,
    waitForAgentRun,
    waitForAgentHistoryReply,
    listCronJobs,
    findManagedDreamingCronJob,
    waitForCronRunCompletion,
    readDoctorMemoryStatus,
    forceMemoryIndex,
    findSkill,
    writeWorkspaceSkill,
    callPluginToolsMcp,
    runAgentPrompt,
    ensureImageGenerationConfigured,
    handleQaAction,
    runRuntimeToolFixture: async (
      envArg: QaSuiteScenarioFlowEnv,
      configArg: Record<string, unknown>,
    ) =>
      runRuntimeToolFixture(envArg, configArg, {
        createSession,
        readEffectiveTools,
        runAgentPrompt,
        fetchJson,
        ensureImageGenerationConfigured,
      }),
    extractQaToolPayload,
    formatMemoryDreamingDay,
    resolveSessionTranscriptsDirForAgent,
    activeMemoryToggleKey,
    setActiveMemorySessionDisabled,
    buildAgentSessionKey,
    normalizeLowercaseStringOrEmpty,
    formatErrorMessage: params.formatErrorMessage,
    liveTurnTimeoutMs: params.liveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs: params.resolveQaLiveTurnTimeoutMs,
    splitModelRef: params.splitModelRef,
    hasDiscoveryLabels,
    reportsDiscoveryScopeLeak,
    reportsMissingDiscoveryFiles,
    hasModelSwitchContinuitySignal,
  };
}

function createQaSuiteScenarioFlowApi(params: QaSuiteScenarioFlowApiParams) {
  return createQaScenarioRuntimeApi({
    env: params.env,
    scenario: params.scenario,
    deps: createQaSuiteScenarioDeps({
      env: params.env,
      runScenario: params.runScenario,
      splitModelRef: params.splitModelRef,
      formatErrorMessage: params.formatErrorMessage,
      liveTurnTimeoutMs: params.liveTurnTimeoutMs,
      resolveQaLiveTurnTimeoutMs: params.resolveQaLiveTurnTimeoutMs,
    }),
    constants: params.constants,
  });
}

export function createQaSuiteScenarioStepRunner(
  env: QaSuiteScenarioFlowEnv,
  scenario: QaSeedScenarioWithSource,
  vars: Record<string, unknown>,
  deps: {
    liveTurnTimeoutMs: QaSuiteScenarioDepsParams["liveTurnTimeoutMs"];
    runScenario: QaSuiteScenarioDepsParams["runScenario"];
  } = {
    liveTurnTimeoutMs: resolveQaLiveTurnTimeoutMs,
    runScenario: runQaSuiteScenarioSteps,
  },
): QaSuiteScenarioDepsParams["runScenario"] {
  const prepareFlow = env.transport.prepareFlow;
  const execution = scenario.execution;
  if (!prepareFlow || execution.kind !== "flow") {
    return deps.runScenario;
  }
  return async (name, steps) =>
    await deps.runScenario(name, [
      {
        name: `Prepare ${env.transport.label}`,
        run: async () => {
          const prepared = await prepareFlow({
            config: execution.config ?? {},
            gateway: env.gateway,
            outputDir: env.outputDir,
            primaryModel: env.primaryModel,
            timeoutMs: execution.timeoutMs ?? deps.liveTurnTimeoutMs(env, 60_000),
            waitForConfigRestartSettle: async (options) =>
              await waitForConfigRestartSettle(env, options?.restartDelayMs, options?.timeoutMs),
          });
          if (prepared) {
            Object.assign(vars, prepared);
          }
        },
      },
      ...steps,
    ]);
}

export async function runQaSuiteScenarioDefinition(params: QaSuiteScenarioFlowApiParams) {
  if (params.scenario.execution.kind !== "flow") {
    throw new Error(`scenario is not a flow: ${params.scenario.id}`);
  }
  if (!params.scenario.execution.flow) {
    throw new Error(`scenario missing flow: ${params.scenario.id}`);
  }
  const vars: Record<string, unknown> = {};
  const api = createQaSuiteScenarioFlowApi({
    ...params,
    runScenario: createQaSuiteScenarioStepRunner(params.env, params.scenario, vars, {
      liveTurnTimeoutMs: params.liveTurnTimeoutMs,
      runScenario: params.runScenario,
    }),
  });
  return await runScenarioFlow({
    api,
    flow: params.scenario.execution.flow,
    scenarioTitle: params.scenario.title,
    vars,
  });
}
