// Qa Lab API module exposes the plugin public contract.
import type * as NodeFs from "node:fs/promises";
import type * as NodePath from "node:path";
import type { QaTransportAdapter } from "./qa-transport.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

type QaScenarioRuntimeFunction = (...args: never[]) => unknown;

type QaScenarioTransport = Pick<
  QaTransportAdapter,
  | "reset"
  | "sendInbound"
  | "sendNativeCommand"
  | "state"
  | "waitForNoOutbound"
  | "waitForOutbound"
  | "waitForCondition"
>;

export type QaScenarioRuntimeEnv<
  TLab = unknown,
  TTransport extends QaScenarioTransport = QaScenarioTransport,
> = {
  lab: TLab;
  transport: TTransport;
};

export type QaScenarioRuntimeDeps = {
  fs: typeof NodeFs;
  path: typeof NodePath;
  sleep: (ms?: number) => Promise<unknown>;
  randomUUID: () => string;
  runScenario: QaScenarioRuntimeFunction;
  waitForOutboundMessage: QaScenarioRuntimeFunction;
  waitForNoOutbound: QaScenarioRuntimeFunction;
  waitForNoTransportOutbound: QaScenarioRuntimeFunction;
  recentOutboundSummary: QaScenarioRuntimeFunction;
  formatConversationTranscript: QaScenarioRuntimeFunction;
  readTransportTranscript: QaScenarioRuntimeFunction;
  formatTransportTranscript: QaScenarioRuntimeFunction;
  fetchJson: QaScenarioRuntimeFunction;
  waitForGatewayHealthy: QaScenarioRuntimeFunction;
  waitForTransportReady: QaScenarioRuntimeFunction;
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
  restartGatewayWithConfigPatch: QaScenarioRuntimeFunction;
  createSession: QaScenarioRuntimeFunction;
  readEffectiveTools: QaScenarioRuntimeFunction;
  readSkillStatus: QaScenarioRuntimeFunction;
  readRawQaSessionStore: QaScenarioRuntimeFunction;
  seedQaSessionTranscript: QaScenarioRuntimeFunction;
  readGatewayLogs: QaScenarioRuntimeFunction;
  markGatewayLogCursor: QaScenarioRuntimeFunction;
  scanGatewayLogSentinels: QaScenarioRuntimeFunction;
  assertNoGatewayLogSentinels: QaScenarioRuntimeFunction;
  readSessionTranscriptSummary: QaScenarioRuntimeFunction;
  runQaCli: QaScenarioRuntimeFunction;
  inspectQaExecutionIdentityStorage: QaScenarioRuntimeFunction;
  extractMediaPathFromText: QaScenarioRuntimeFunction;
  resolveGeneratedImagePath: QaScenarioRuntimeFunction;
  startAgentRun: QaScenarioRuntimeFunction;
  waitForAgentRun: QaScenarioRuntimeFunction;
  waitForSessionRunAfter: QaScenarioRuntimeFunction;
  waitForAgentHistoryReply: QaScenarioRuntimeFunction;
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
  runRuntimeToolFixture: QaScenarioRuntimeFunction;
  extractQaToolPayload: QaScenarioRuntimeFunction;
  formatMemoryDreamingDay: QaScenarioRuntimeFunction;
  resolveSessionTranscriptsDirForAgent: QaScenarioRuntimeFunction;
  activeMemoryToggleKey: QaScenarioRuntimeFunction;
  setActiveMemorySessionDisabled: QaScenarioRuntimeFunction;
  buildAgentSessionKey: QaScenarioRuntimeFunction;
  normalizeLowercaseStringOrEmpty: QaScenarioRuntimeFunction;
  formatErrorMessage: QaScenarioRuntimeFunction;
  liveTurnTimeoutMs: QaScenarioRuntimeFunction;
  resolveQaLiveTurnTimeoutMs: QaScenarioRuntimeFunction;
  normalizeModelRef: QaScenarioRuntimeFunction;
  splitModelRef: QaScenarioRuntimeFunction;
  hasDiscoveryLabels: QaScenarioRuntimeFunction;
  reportsDiscoveryScopeLeak: QaScenarioRuntimeFunction;
  reportsMissingDiscoveryFiles: QaScenarioRuntimeFunction;
  hasModelSwitchContinuitySignal: QaScenarioRuntimeFunction;
};

type QaScenarioRuntimeApiDeps = Pick<QaScenarioRuntimeDeps, "sleep" | "waitForTransportReady">;

type QaScenarioRuntimeConstants = {
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
};

type QaScenarioRuntimeApi<
  TEnv extends QaScenarioRuntimeEnv = QaScenarioRuntimeEnv,
  TDeps extends QaScenarioRuntimeApiDeps = QaScenarioRuntimeDeps,
> = TDeps & {
  env: TEnv;
  lab: TEnv["lab"];
  transport: TEnv["transport"];
  state: TEnv["transport"]["state"];
  scenario: QaSeedScenarioWithSource;
  config: Record<string, unknown>;
  waitForCondition: TEnv["transport"]["waitForCondition"];
  waitForChannelReady: TDeps["waitForTransportReady"];
  waitForQaChannelReady: TDeps["waitForTransportReady"];
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
  getTransportSnapshot: TEnv["transport"]["state"]["getSnapshot"];
  resetTransport: () => Promise<void>;
  injectInboundMessage: TEnv["transport"]["state"]["addInboundMessage"];
  injectOutboundMessage: TEnv["transport"]["state"]["addOutboundMessage"];
  readTransportMessage: TEnv["transport"]["state"]["readMessage"];
  resetBus: () => Promise<void>;
  reset: () => Promise<void>;
};

export function createQaScenarioRuntimeApi<
  TEnv extends QaScenarioRuntimeEnv,
  TDeps extends QaScenarioRuntimeApiDeps,
>(params: {
  env: TEnv;
  scenario: QaSeedScenarioWithSource;
  deps: TDeps;
  constants: QaScenarioRuntimeConstants;
}): QaScenarioRuntimeApi<TEnv, TDeps> {
  const transport = params.env.transport;
  const transportState = transport.state;
  const resetTransportState = async () => {
    await transport.reset();
    await params.deps.sleep(100);
  };

  return {
    ...params.deps,
    env: params.env,
    lab: params.env.lab,
    transport,
    state: transportState,
    scenario: params.scenario,
    config: params.scenario.execution.config ?? {},
    waitForCondition: transport.waitForCondition,
    waitForChannelReady: params.deps.waitForTransportReady,
    waitForQaChannelReady: params.deps.waitForTransportReady,
    imageUnderstandingPngBase64: params.constants.imageUnderstandingPngBase64,
    imageUnderstandingLargePngBase64: params.constants.imageUnderstandingLargePngBase64,
    imageUnderstandingValidPngBase64: params.constants.imageUnderstandingValidPngBase64,
    getTransportSnapshot: transportState.getSnapshot.bind(transportState),
    resetTransport: resetTransportState,
    injectInboundMessage: transportState.addInboundMessage.bind(transportState),
    injectOutboundMessage: transportState.addOutboundMessage.bind(transportState),
    readTransportMessage: transportState.readMessage.bind(transportState),
    resetBus: resetTransportState,
    reset: resetTransportState,
  };
}
