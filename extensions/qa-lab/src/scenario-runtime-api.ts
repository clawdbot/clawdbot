import type * as NodeFs from "node:fs/promises";
import type * as NodePath from "node:path";
import type { QaTransportState } from "./qa-transport.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

type QaScenarioRuntimeFunction = (...args: never[]) => unknown;

export type QaScenarioRuntimeEnv<
  TLab = unknown,
  TTransportState extends QaTransportState = QaTransportState,
> = {
  lab: TLab;
  transport: {
    state: TTransportState;
    capabilities: {
      waitForCondition: QaScenarioRuntimeFunction;
      getNormalizedMessageState: () => ReturnType<TTransportState["getSnapshot"]>;
      resetNormalizedMessageState: () => Promise<void>;
      sendInboundMessage: TTransportState["addInboundMessage"];
      injectOutboundMessage: TTransportState["addOutboundMessage"];
      readNormalizedMessage: TTransportState["readMessage"];
    };
  };
};

export type QaScenarioRuntimeDeps = {
  fs: typeof NodeFs;
  path: typeof NodePath;
  sleep: (ms?: number) => Promise<unknown>;
  randomUUID: () => string;
  runScenario: QaScenarioRuntimeFunction;
  waitForOutboundMessage: QaScenarioRuntimeFunction;
  waitForTransportOutboundMessage: QaScenarioRuntimeFunction;
  waitForChannelOutboundMessage: QaScenarioRuntimeFunction;
  waitForNoOutbound: QaScenarioRuntimeFunction;
  waitForNoTransportOutbound: QaScenarioRuntimeFunction;
  recentOutboundSummary: QaScenarioRuntimeFunction;
  formatConversationTranscript: QaScenarioRuntimeFunction;
  readTransportTranscript: QaScenarioRuntimeFunction;
  formatTransportTranscript: QaScenarioRuntimeFunction;
  fetchJson: QaScenarioRuntimeFunction;
  waitForGatewayHealthy: QaScenarioRuntimeFunction;
  waitForTransportReady: QaScenarioRuntimeFunction;
  waitForQaChannelReady: QaScenarioRuntimeFunction;
  browserRequest: QaScenarioRuntimeFunction;
  waitForBrowserReady: QaScenarioRuntimeFunction;
  browserOpenTab: QaScenarioRuntimeFunction;
  browserSnapshot: QaScenarioRuntimeFunction;
  browserAct: QaScenarioRuntimeFunction;
  webOpenPage: QaScenarioRuntimeFunction;
  webWait: QaScenarioRuntimeFunction;
  webType: QaScenarioRuntimeFunction;
  webSnapshot: QaScenarioRuntimeFunction;
  webEvaluate: QaScenarioRuntimeFunction;
  waitForConfigRestartSettle: QaScenarioRuntimeFunction;
  patchConfig: QaScenarioRuntimeFunction;
  applyConfig: QaScenarioRuntimeFunction;
  readConfigSnapshot: QaScenarioRuntimeFunction;
  createSession: QaScenarioRuntimeFunction;
  readEffectiveTools: QaScenarioRuntimeFunction;
  readSkillStatus: QaScenarioRuntimeFunction;
  readRawQaSessionStore: QaScenarioRuntimeFunction;
  readGatewayLogs: QaScenarioRuntimeFunction;
  markGatewayLogCursor: QaScenarioRuntimeFunction;
  scanGatewayLogSentinels: QaScenarioRuntimeFunction;
  assertNoGatewayLogSentinels: QaScenarioRuntimeFunction;
  readSessionTranscriptSummary: QaScenarioRuntimeFunction;
  runQaCli: QaScenarioRuntimeFunction;
  extractMediaPathFromText: QaScenarioRuntimeFunction;
  resolveGeneratedImagePath: QaScenarioRuntimeFunction;
  startAgentRun: QaScenarioRuntimeFunction;
  waitForAgentRun: QaScenarioRuntimeFunction;
  listCronJobs: QaScenarioRuntimeFunction;
  findManagedDreamingCronJob: QaScenarioRuntimeFunction;
  waitForCronRunCompletion: QaScenarioRuntimeFunction;
  readDoctorMemoryStatus: QaScenarioRuntimeFunction;
  forceMemoryIndex: QaScenarioRuntimeFunction;
  findSkill: QaScenarioRuntimeFunction;
  writeWorkspaceSkill: QaScenarioRuntimeFunction;
  callPluginToolsMcp: QaScenarioRuntimeFunction;
  runAgentPrompt: QaScenarioRuntimeFunction;
  ensureImageGenerationConfigured: QaScenarioRuntimeFunction;
  handleQaAction: QaScenarioRuntimeFunction;
  extractQaToolPayload: QaScenarioRuntimeFunction;
  formatMemoryDreamingDay: QaScenarioRuntimeFunction;
  resolveSessionTranscriptsDirForAgent: QaScenarioRuntimeFunction;
  buildAgentSessionKey: QaScenarioRuntimeFunction;
  normalizeLowercaseStringOrEmpty: QaScenarioRuntimeFunction;
  formatErrorMessage: QaScenarioRuntimeFunction;
  liveTurnTimeoutMs: QaScenarioRuntimeFunction;
  resolveQaLiveTurnTimeoutMs: QaScenarioRuntimeFunction;
  splitModelRef: QaScenarioRuntimeFunction;
  qaChannelPlugin: unknown;
  hasDiscoveryLabels: QaScenarioRuntimeFunction;
  reportsDiscoveryScopeLeak: QaScenarioRuntimeFunction;
  reportsMissingDiscoveryFiles: QaScenarioRuntimeFunction;
  hasModelSwitchContinuityEvidence: QaScenarioRuntimeFunction;
};

export type QaScenarioRuntimeConstants = {
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
};

type QaScenarioRuntimeApi<
  TEnv extends QaScenarioRuntimeEnv = QaScenarioRuntimeEnv,
  TDeps extends QaScenarioRuntimeDeps = QaScenarioRuntimeDeps,
> = {
  env: TEnv;
  lab: TEnv["lab"];
  state: TEnv["transport"]["state"];
  scenario: QaSeedScenarioWithSource;
  config: Record<string, unknown>;
  fs: typeof NodeFs;
  path: typeof NodePath;
  sleep: (ms?: number) => Promise<unknown>;
  randomUUID: () => string;
  runScenario: TDeps["runScenario"];
  waitForCondition: TEnv["transport"]["capabilities"]["waitForCondition"];
  waitForOutboundMessage: TDeps["waitForOutboundMessage"];
  waitForTransportOutboundMessage: TDeps["waitForTransportOutboundMessage"];
  waitForChannelOutboundMessage: TDeps["waitForChannelOutboundMessage"];
  waitForNoOutbound: TDeps["waitForNoOutbound"];
  waitForNoTransportOutbound: TDeps["waitForNoTransportOutbound"];
  recentOutboundSummary: TDeps["recentOutboundSummary"];
  formatConversationTranscript: TDeps["formatConversationTranscript"];
  readTransportTranscript: TDeps["readTransportTranscript"];
  formatTransportTranscript: TDeps["formatTransportTranscript"];
  fetchJson: TDeps["fetchJson"];
  waitForGatewayHealthy: TDeps["waitForGatewayHealthy"];
  waitForTransportReady: TDeps["waitForTransportReady"];
  waitForChannelReady: TDeps["waitForTransportReady"];
  waitForQaChannelReady: TDeps["waitForQaChannelReady"];
  browserRequest: TDeps["browserRequest"];
  waitForBrowserReady: TDeps["waitForBrowserReady"];
  browserOpenTab: TDeps["browserOpenTab"];
  browserSnapshot: TDeps["browserSnapshot"];
  browserAct: TDeps["browserAct"];
  webOpenPage: TDeps["webOpenPage"];
  webWait: TDeps["webWait"];
  webType: TDeps["webType"];
  webSnapshot: TDeps["webSnapshot"];
  webEvaluate: TDeps["webEvaluate"];
  waitForConfigRestartSettle: TDeps["waitForConfigRestartSettle"];
  patchConfig: TDeps["patchConfig"];
  applyConfig: TDeps["applyConfig"];
  readConfigSnapshot: TDeps["readConfigSnapshot"];
  createSession: TDeps["createSession"];
  readEffectiveTools: TDeps["readEffectiveTools"];
  readSkillStatus: TDeps["readSkillStatus"];
  readRawQaSessionStore: TDeps["readRawQaSessionStore"];
  readGatewayLogs: TDeps["readGatewayLogs"];
  markGatewayLogCursor: TDeps["markGatewayLogCursor"];
  scanGatewayLogSentinels: TDeps["scanGatewayLogSentinels"];
  assertNoGatewayLogSentinels: TDeps["assertNoGatewayLogSentinels"];
  readSessionTranscriptSummary: TDeps["readSessionTranscriptSummary"];
  runQaCli: TDeps["runQaCli"];
  extractMediaPathFromText: TDeps["extractMediaPathFromText"];
  resolveGeneratedImagePath: TDeps["resolveGeneratedImagePath"];
  startAgentRun: TDeps["startAgentRun"];
  waitForAgentRun: TDeps["waitForAgentRun"];
  listCronJobs: TDeps["listCronJobs"];
  findManagedDreamingCronJob: TDeps["findManagedDreamingCronJob"];
  waitForCronRunCompletion: TDeps["waitForCronRunCompletion"];
  readDoctorMemoryStatus: TDeps["readDoctorMemoryStatus"];
  forceMemoryIndex: TDeps["forceMemoryIndex"];
  findSkill: TDeps["findSkill"];
  writeWorkspaceSkill: TDeps["writeWorkspaceSkill"];
  callPluginToolsMcp: TDeps["callPluginToolsMcp"];
  runAgentPrompt: TDeps["runAgentPrompt"];
  ensureImageGenerationConfigured: TDeps["ensureImageGenerationConfigured"];
  handleQaAction: TDeps["handleQaAction"];
  extractQaToolPayload: TDeps["extractQaToolPayload"];
  formatMemoryDreamingDay: TDeps["formatMemoryDreamingDay"];
  resolveSessionTranscriptsDirForAgent: TDeps["resolveSessionTranscriptsDirForAgent"];
  buildAgentSessionKey: TDeps["buildAgentSessionKey"];
  normalizeLowercaseStringOrEmpty: TDeps["normalizeLowercaseStringOrEmpty"];
  formatErrorMessage: TDeps["formatErrorMessage"];
  liveTurnTimeoutMs: TDeps["liveTurnTimeoutMs"];
  resolveQaLiveTurnTimeoutMs: TDeps["resolveQaLiveTurnTimeoutMs"];
  splitModelRef: TDeps["splitModelRef"];
  qaChannelPlugin: unknown;
  hasDiscoveryLabels: TDeps["hasDiscoveryLabels"];
  reportsDiscoveryScopeLeak: TDeps["reportsDiscoveryScopeLeak"];
  reportsMissingDiscoveryFiles: TDeps["reportsMissingDiscoveryFiles"];
  hasModelSwitchContinuityEvidence: TDeps["hasModelSwitchContinuityEvidence"];
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
  getTransportSnapshot: TEnv["transport"]["capabilities"]["getNormalizedMessageState"];
  resetTransport: () => Promise<void>;
  injectInboundMessage: TEnv["transport"]["capabilities"]["sendInboundMessage"];
  injectOutboundMessage: TEnv["transport"]["capabilities"]["injectOutboundMessage"];
  readTransportMessage: TEnv["transport"]["capabilities"]["readNormalizedMessage"];
  resetBus: () => Promise<void>;
  reset: () => Promise<void>;
};

export function createQaScenarioRuntimeApi<
  TEnv extends QaScenarioRuntimeEnv,
  TDeps extends QaScenarioRuntimeDeps,
>(params: {
  env: TEnv;
  scenario: QaSeedScenarioWithSource;
  deps: TDeps;
  constants: QaScenarioRuntimeConstants;
}): QaScenarioRuntimeApi<TEnv, TDeps> {
  const resetTransportState = async () => {
    await params.env.transport.capabilities.resetNormalizedMessageState();
    await params.deps.sleep(100);
  };

  return {
    env: params.env,
    lab: params.env.lab,
    state: params.env.transport.state,
    scenario: params.scenario,
    config: params.scenario.execution.config ?? {},
    fs: params.deps.fs,
    path: params.deps.path,
    sleep: params.deps.sleep,
    randomUUID: params.deps.randomUUID,
    runScenario: params.deps.runScenario,
    waitForCondition: params.env.transport.capabilities.waitForCondition,
    waitForOutboundMessage: params.deps.waitForOutboundMessage,
    waitForTransportOutboundMessage: params.deps.waitForTransportOutboundMessage,
    waitForChannelOutboundMessage: params.deps.waitForChannelOutboundMessage,
    waitForNoOutbound: params.deps.waitForNoOutbound,
    waitForNoTransportOutbound: params.deps.waitForNoTransportOutbound,
    recentOutboundSummary: params.deps.recentOutboundSummary,
    formatConversationTranscript: params.deps.formatConversationTranscript,
    readTransportTranscript: params.deps.readTransportTranscript,
    formatTransportTranscript: params.deps.formatTransportTranscript,
    fetchJson: params.deps.fetchJson,
    waitForGatewayHealthy: params.deps.waitForGatewayHealthy,
    waitForTransportReady: params.deps.waitForTransportReady,
    waitForChannelReady: params.deps.waitForTransportReady,
    waitForQaChannelReady: params.deps.waitForQaChannelReady,
    browserRequest: params.deps.browserRequest,
    waitForBrowserReady: params.deps.waitForBrowserReady,
    browserOpenTab: params.deps.browserOpenTab,
    browserSnapshot: params.deps.browserSnapshot,
    browserAct: params.deps.browserAct,
    webOpenPage: params.deps.webOpenPage,
    webWait: params.deps.webWait,
    webType: params.deps.webType,
    webSnapshot: params.deps.webSnapshot,
    webEvaluate: params.deps.webEvaluate,
    waitForConfigRestartSettle: params.deps.waitForConfigRestartSettle,
    patchConfig: params.deps.patchConfig,
    applyConfig: params.deps.applyConfig,
    readConfigSnapshot: params.deps.readConfigSnapshot,
    createSession: params.deps.createSession,
    readEffectiveTools: params.deps.readEffectiveTools,
    readSkillStatus: params.deps.readSkillStatus,
    readRawQaSessionStore: params.deps.readRawQaSessionStore,
    readGatewayLogs: params.deps.readGatewayLogs,
    markGatewayLogCursor: params.deps.markGatewayLogCursor,
    scanGatewayLogSentinels: params.deps.scanGatewayLogSentinels,
    assertNoGatewayLogSentinels: params.deps.assertNoGatewayLogSentinels,
    readSessionTranscriptSummary: params.deps.readSessionTranscriptSummary,
    runQaCli: params.deps.runQaCli,
    extractMediaPathFromText: params.deps.extractMediaPathFromText,
    resolveGeneratedImagePath: params.deps.resolveGeneratedImagePath,
    startAgentRun: params.deps.startAgentRun,
    waitForAgentRun: params.deps.waitForAgentRun,
    listCronJobs: params.deps.listCronJobs,
    findManagedDreamingCronJob: params.deps.findManagedDreamingCronJob,
    waitForCronRunCompletion: params.deps.waitForCronRunCompletion,
    readDoctorMemoryStatus: params.deps.readDoctorMemoryStatus,
    forceMemoryIndex: params.deps.forceMemoryIndex,
    findSkill: params.deps.findSkill,
    writeWorkspaceSkill: params.deps.writeWorkspaceSkill,
    callPluginToolsMcp: params.deps.callPluginToolsMcp,
    runAgentPrompt: params.deps.runAgentPrompt,
    ensureImageGenerationConfigured: params.deps.ensureImageGenerationConfigured,
    handleQaAction: params.deps.handleQaAction,
    extractQaToolPayload: params.deps.extractQaToolPayload,
    formatMemoryDreamingDay: params.deps.formatMemoryDreamingDay,
    resolveSessionTranscriptsDirForAgent: params.deps.resolveSessionTranscriptsDirForAgent,
    buildAgentSessionKey: params.deps.buildAgentSessionKey,
    normalizeLowercaseStringOrEmpty: params.deps.normalizeLowercaseStringOrEmpty,
    formatErrorMessage: params.deps.formatErrorMessage,
    liveTurnTimeoutMs: params.deps.liveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs: params.deps.resolveQaLiveTurnTimeoutMs,
    splitModelRef: params.deps.splitModelRef,
    qaChannelPlugin: params.deps.qaChannelPlugin,
    hasDiscoveryLabels: params.deps.hasDiscoveryLabels,
    reportsDiscoveryScopeLeak: params.deps.reportsDiscoveryScopeLeak,
    reportsMissingDiscoveryFiles: params.deps.reportsMissingDiscoveryFiles,
    hasModelSwitchContinuityEvidence: params.deps.hasModelSwitchContinuityEvidence,
    imageUnderstandingPngBase64: params.constants.imageUnderstandingPngBase64,
    imageUnderstandingLargePngBase64: params.constants.imageUnderstandingLargePngBase64,
    imageUnderstandingValidPngBase64: params.constants.imageUnderstandingValidPngBase64,
    getTransportSnapshot: params.env.transport.capabilities.getNormalizedMessageState,
    resetTransport: resetTransportState,
    injectInboundMessage: params.env.transport.capabilities.sendInboundMessage,
    injectOutboundMessage: params.env.transport.capabilities.injectOutboundMessage,
    readTransportMessage: params.env.transport.capabilities.readNormalizedMessage,
    resetBus: resetTransportState,
    reset: resetTransportState,
  };
}
