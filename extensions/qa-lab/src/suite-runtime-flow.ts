import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-host-core";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-host-status";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
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
import { extractQaToolPayload } from "./extract-tool-payload.js";
import { hasModelSwitchContinuityEvidence } from "./model-switch-eval.js";
import { qaChannelPlugin } from "./runtime-api.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
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
  readSkillStatus,
  resolveGeneratedImagePath,
  runAgentPrompt,
  runQaCli,
  startAgentRun,
  waitForAgentRun,
  writeWorkspaceSkill,
} from "./suite-runtime-agent.js";
import {
  applyConfig,
  fetchJson,
  patchConfig,
  readConfigSnapshot,
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

type QaSuiteStep = {
  name: string;
  run: () => Promise<string | void>;
};

type QaSuiteScenarioResult = {
  name: string;
  status: "pass" | "fail";
  steps: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
    details?: string;
  }>;
  details?: string;
};

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
      const opened = await qaWebOpenPage(webParams);
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
    createSession,
    readEffectiveTools,
    readSkillStatus,
    readRawQaSessionStore,
    runQaCli,
    extractMediaPathFromText,
    resolveGeneratedImagePath,
    startAgentRun,
    waitForAgentRun,
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
    extractQaToolPayload,
    formatMemoryDreamingDay,
    resolveSessionTranscriptsDirForAgent,
    buildAgentSessionKey,
    normalizeLowercaseStringOrEmpty,
    formatErrorMessage: params.formatErrorMessage,
    liveTurnTimeoutMs: params.liveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs: params.resolveQaLiveTurnTimeoutMs,
    splitModelRef: params.splitModelRef,
    qaChannelPlugin,
    hasDiscoveryLabels,
    reportsDiscoveryScopeLeak,
    reportsMissingDiscoveryFiles,
    hasModelSwitchContinuityEvidence,
  };
}

export function createQaSuiteScenarioFlowApi(params: QaSuiteScenarioFlowApiParams) {
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
