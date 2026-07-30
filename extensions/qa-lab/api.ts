// Qa Lab API module exposes the plugin public contract.
export {
  buildQaBusSnapshot,
  cloneEvent,
  cloneMessage,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeConversationFromTarget,
  pollQaBusEvents,
  readQaBusMessage,
  searchQaBusMessages,
} from "./src/bus-queries.js";
export {
  closeQaHttpServer,
  createQaBusServer,
  handleQaBusRequest,
  startQaBusServer,
  writeError,
  writeJson,
} from "./src/bus-server.js";
export { createQaBusState, type QaBusState } from "./src/bus-state.js";
export {
  createQaBusWaiterStore,
  DEFAULT_WAIT_TIMEOUT_MS,
  type QaBusWaitMatch,
} from "./src/bus-waiters.js";
export { isQaLabCliAvailable, registerQaLabCli } from "./src/cli.js";
export { createQaRunnerRuntime } from "./src/harness-runtime.js";
export {
  buildScriptEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  type QaEvidencePackageSource,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
  validateQaEvidenceSummaryJson,
} from "./src/evidence-summary.js";
export type { QaProviderMode } from "./src/providers/index.js";
export {
  type QaLabLatestReport,
  type QaLabScenarioOutcome,
  type QaLabScenarioRun,
  type QaLabServerHandle,
  type QaLabServerStartParams,
  startQaLabServer,
} from "./src/lab-server.js";
export { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./src/docker-harness.js";
export {
  buildQaScenarioPlanMarkdown,
  readQaAgentIdentityMarkdown,
} from "./src/qa-agent-bootstrap.js";
export { seedQaAgentWorkspace } from "./src/qa-agent-workspace.js";
export {
  buildQaGatewayConfig,
  DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
  mergeQaControlUiAllowedOrigins,
  normalizeQaThinkingLevel,
  QA_BASE_RUNTIME_PLUGIN_IDS,
  type QaThinkingLevel,
} from "./src/qa-gateway-config.js";
export { renderQaMarkdownReport, type QaReportCheck, type QaReportScenario } from "./src/report.js";
export {
  type QaScenarioDefinition,
  type QaScenarioResult,
  type QaScenarioStep,
  type QaScenarioStepContext,
  type QaScenarioStepResult,
  runQaScenario,
} from "./src/scenario.js";
export {
  DEFAULT_QA_AGENT_IDENTITY_MARKDOWN,
  hasQaScenarioPack,
  listQaScenarioYamlPaths,
  type QaBootstrapScenarioCatalog,
  type QaScenarioExecution,
  type QaScenarioFlow,
  type QaScenarioPack,
  type QaSeedScenario,
  type QaSeedScenarioWithSource,
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioOverviewMarkdown,
  readQaScenarioPack,
  readQaScenarioPackYamlSource,
  validateQaScenarioExecutionConfig,
} from "./src/scenario-catalog.js";
export { createQaSelfCheckScenario } from "./src/self-check-scenario.js";
export {
  isQaSelfCheckSuccessful,
  type QaSelfCheckResult,
  resolveQaSelfCheckOutputPath,
  runQaSelfCheckAgainstState,
} from "./src/self-check.js";
export { runQaE2eSelfCheck, runQaLabSelfCheck } from "./src/self-check-runner.js";
export {
  testing,
  testing as __testing,
  buildQaRuntimeEnv,
  type QaCliBackendAuthMode,
  type QaGatewayChildListeningContext,
  type QaGatewayChildCommand,
  type QaGatewayChildStateMutationContext,
  resolveQaControlUiRoot,
  resolveQaGatewayChildProviderMode,
  startQaGatewayChild,
} from "./src/gateway-child.js";
export {
  buildQaSuiteSummaryJson,
  qaSuiteProgressTesting,
  type QaSuiteResult,
  type QaSuiteRunParams,
  type QaSuiteScenarioResult,
  type QaSuiteStartLabFn,
  type QaSuiteSummaryJson,
  type QaSuiteSummaryJsonParams,
  runQaFlowSuite,
} from "./src/suite.js";
export { runQaSuite, type QaSuiteRuntimeResult } from "./src/suite-launch.runtime.js";
