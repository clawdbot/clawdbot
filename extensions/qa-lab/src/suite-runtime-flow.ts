// Qa Lab plugin module implements suite runtime flow behavior.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage as formatQaErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-host-core";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import * as browserRuntime from "./browser-runtime.js";
import * as cronRunWait from "./cron-run-wait.js";
import * as discoveryEval from "./discovery-eval.js";
import { QaSuiteScenarioSkipError } from "./errors.js";
import * as extractToolPayload from "./extract-tool-payload.js";
import { assertNoGatewayLogSentinels, scanGatewayLogSentinels } from "./gateway-log-sentinel.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import * as modelSwitchEval from "./model-switch-eval.js";
import * as runtimeToolFixture from "./runtime-tool-fixture.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import {
  createQaScenarioRuntimeApi,
  type QaScenarioRuntimeDeps,
  type QaScenarioRuntimeEnv,
} from "./scenario-runtime-api.js";
import * as suiteRuntimeAgent from "./suite-runtime-agent.js";
import * as suiteRuntimeGateway from "./suite-runtime-gateway.js";
import * as suiteRuntimeTransport from "./suite-runtime-transport.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import * as webRuntime from "./web-runtime.js";

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

const qaSuiteScenarioIdentityDeps = {
  fs,
  path,
  sleep,
  randomUUID,
  ...suiteRuntimeAgent,
  ...suiteRuntimeGateway,
  ...suiteRuntimeTransport,
  ...extractToolPayload,
  waitForCronRunCompletion: cronRunWait.waitForCronRunCompletion,
  hasDiscoveryLabels: discoveryEval.hasDiscoveryLabels,
  reportsDiscoveryScopeLeak: discoveryEval.reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles: discoveryEval.reportsMissingDiscoveryFiles,
  hasModelSwitchContinuitySignal: modelSwitchEval.hasModelSwitchContinuitySignal,
  formatMemoryDreamingDay,
  resolveSessionTranscriptsDirForAgent,
  activeMemoryToggleKey,
  setActiveMemorySessionDisabled,
  buildAgentSessionKey,
  normalizeLowercaseStringOrEmpty,
};

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
  const waitForAccountOutboundMessage: typeof suiteRuntimeTransport.waitForOutboundMessage = (
    state,
    predicate,
    timeoutMs,
    options,
  ) =>
    suiteRuntimeTransport.waitForOutboundMessage(state, predicate, timeoutMs, {
      ...options,
      accountId: params.env.transport.accountId,
    });
  return {
    ...qaSuiteScenarioIdentityDeps,
    runScenario: params.runScenario,
    waitForOutboundMessage: waitForAccountOutboundMessage,
    browserRequest: browserRuntime.callQaBrowserRequest,
    waitForBrowserReady: browserRuntime.waitForQaBrowserReady,
    browserOpenTab: browserRuntime.qaBrowserOpenTab,
    browserSnapshot: browserRuntime.qaBrowserSnapshot,
    browserAct: browserRuntime.qaBrowserAct,
    webOpenPage: async (webParams: Parameters<typeof webRuntime.qaWebOpenPage>[0]) => {
      const opened = await webRuntime.qaWebOpenPage({
        ...webParams,
        repoRoot: params.env.repoRoot,
      });
      params.env.webSessionIds.add(opened.pageId);
      return opened;
    },
    webWait: webRuntime.qaWebWait,
    webType: webRuntime.qaWebType,
    webSnapshot: webRuntime.qaWebSnapshot,
    webEvaluate: webRuntime.qaWebEvaluate,
    readGatewayLogs: () => params.env.gateway.logs?.() ?? "",
    markGatewayLogCursor: () => (params.env.gateway.logs?.() ?? "").length,
    scanGatewayLogSentinels: (options?: Parameters<typeof scanGatewayLogSentinels>[1]) =>
      scanGatewayLogSentinels(params.env.gateway.logs?.(), options),
    assertNoGatewayLogSentinels: (options?: Parameters<typeof assertNoGatewayLogSentinels>[1]) =>
      assertNoGatewayLogSentinels(params.env.gateway.logs?.(), options),
    runRuntimeToolFixture: async (
      envArg: QaSuiteScenarioFlowEnv,
      configArg: Record<string, unknown>,
    ) =>
      runtimeToolFixture.runRuntimeToolFixture(envArg, configArg, {
        createSession: suiteRuntimeAgent.createSession,
        readEffectiveTools: suiteRuntimeAgent.readEffectiveTools,
        runAgentPrompt: suiteRuntimeAgent.runAgentPrompt,
        fetchJson: suiteRuntimeGateway.fetchJson,
        ensureImageGenerationConfigured: suiteRuntimeAgent.ensureImageGenerationConfigured,
      }),
    formatErrorMessage: params.formatErrorMessage,
    liveTurnTimeoutMs: params.liveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs: params.resolveQaLiveTurnTimeoutMs,
    normalizeModelRef: (raw: string) => {
      const split = params.splitModelRef(raw);
      return split
        ? (resolveModelRefFromString({
            cfg: params.env.cfg,
            raw,
            defaultProvider: split.provider,
          })?.ref ?? null)
        : null;
    },
    splitModelRef: params.splitModelRef,
  } satisfies QaScenarioRuntimeDeps;
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

function createQaSuiteScenarioStepRunner(
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
            scenarioId: scenario.id,
            scenarioTitle: scenario.title,
            timeoutMs: execution.timeoutMs ?? deps.liveTurnTimeoutMs(env, 60_000),
            waitForConfigRestartSettle: async (options) =>
              await suiteRuntimeGateway.waitForConfigRestartSettle(
                env,
                options?.restartDelayMs,
                options?.timeoutMs,
              ),
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
