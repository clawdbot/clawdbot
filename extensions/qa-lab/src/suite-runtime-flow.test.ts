import { describe, expect, it, vi } from "vitest";

const createQaScenarioRuntimeApi = vi.hoisted(() => vi.fn());
const waitForOutboundMessage = vi.hoisted(() => vi.fn());
const waitForTransportOutboundMessage = vi.hoisted(() => vi.fn());
const waitForChannelOutboundMessage = vi.hoisted(() => vi.fn());
const waitForNoOutbound = vi.hoisted(() => vi.fn());
const waitForNoTransportOutbound = vi.hoisted(() => vi.fn());
const recentOutboundSummary = vi.hoisted(() => vi.fn());
const formatConversationTranscript = vi.hoisted(() => vi.fn());
const readTransportTranscript = vi.hoisted(() => vi.fn());
const formatTransportTranscript = vi.hoisted(() => vi.fn());
const fetchJson = vi.hoisted(() => vi.fn());
const waitForGatewayHealthy = vi.hoisted(() => vi.fn());
const waitForTransportReady = vi.hoisted(() => vi.fn());
const waitForQaChannelReady = vi.hoisted(() => vi.fn());
const patchConfig = vi.hoisted(() => vi.fn());
const applyConfig = vi.hoisted(() => vi.fn());
const readConfigSnapshot = vi.hoisted(() => vi.fn());
const waitForConfigRestartSettle = vi.hoisted(() => vi.fn());
const createSession = vi.hoisted(() => vi.fn());
const readEffectiveTools = vi.hoisted(() => vi.fn());
const readSkillStatus = vi.hoisted(() => vi.fn());
const readRawQaSessionStore = vi.hoisted(() => vi.fn());
const runQaCli = vi.hoisted(() => vi.fn());
const extractMediaPathFromText = vi.hoisted(() => vi.fn());
const resolveGeneratedImagePath = vi.hoisted(() => vi.fn());
const startAgentRun = vi.hoisted(() => vi.fn());
const waitForAgentRun = vi.hoisted(() => vi.fn());
const listCronJobs = vi.hoisted(() => vi.fn());
const findManagedDreamingCronJob = vi.hoisted(() => vi.fn());
const waitForCronRunCompletion = vi.hoisted(() => vi.fn());
const readDoctorMemoryStatus = vi.hoisted(() => vi.fn());
const forceMemoryIndex = vi.hoisted(() => vi.fn());
const findSkill = vi.hoisted(() => vi.fn());
const writeWorkspaceSkill = vi.hoisted(() => vi.fn());
const callPluginToolsMcp = vi.hoisted(() => vi.fn());
const runAgentPrompt = vi.hoisted(() => vi.fn());
const ensureImageGenerationConfigured = vi.hoisted(() => vi.fn());
const handleQaAction = vi.hoisted(() => vi.fn());
const extractQaToolPayload = vi.hoisted(() => vi.fn());
const browserRequest = vi.hoisted(() => vi.fn());
const waitForBrowserReady = vi.hoisted(() => vi.fn());
const browserOpenTab = vi.hoisted(() => vi.fn());
const browserSnapshot = vi.hoisted(() => vi.fn());
const browserAct = vi.hoisted(() => vi.fn());
const webOpenPage = vi.hoisted(() => vi.fn(async () => ({ pageId: "page-1" })));
const webWait = vi.hoisted(() => vi.fn());
const webType = vi.hoisted(() => vi.fn());
const webSnapshot = vi.hoisted(() => vi.fn());
const webEvaluate = vi.hoisted(() => vi.fn());
const hasDiscoveryLabels = vi.hoisted(() => vi.fn());
const reportsDiscoveryScopeLeak = vi.hoisted(() => vi.fn());
const reportsMissingDiscoveryFiles = vi.hoisted(() => vi.fn());
const hasModelSwitchContinuityEvidence = vi.hoisted(() => vi.fn());
const qaChannelPlugin = vi.hoisted(() => ({ id: "qa-channel" }));

vi.mock("./scenario-runtime-api.js", () => ({
  createQaScenarioRuntimeApi,
}));

vi.mock("./suite-runtime-transport.js", () => ({
  waitForOutboundMessage,
  waitForTransportOutboundMessage,
  waitForChannelOutboundMessage,
  waitForNoOutbound,
  waitForNoTransportOutbound,
  recentOutboundSummary,
  formatConversationTranscript,
  readTransportTranscript,
  formatTransportTranscript,
}));

vi.mock("./suite-runtime-gateway.js", () => ({
  fetchJson,
  waitForGatewayHealthy,
  waitForTransportReady,
  waitForQaChannelReady,
  waitForConfigRestartSettle,
  patchConfig,
  applyConfig,
  readConfigSnapshot,
}));

vi.mock("./suite-runtime-agent.js", () => ({
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
  readDoctorMemoryStatus,
  forceMemoryIndex,
  findSkill,
  writeWorkspaceSkill,
  callPluginToolsMcp,
  runAgentPrompt,
  ensureImageGenerationConfigured,
  handleQaAction,
}));

vi.mock("./browser-runtime.js", () => ({
  callQaBrowserRequest: browserRequest,
  waitForQaBrowserReady: waitForBrowserReady,
  qaBrowserOpenTab: browserOpenTab,
  qaBrowserSnapshot: browserSnapshot,
  qaBrowserAct: browserAct,
}));

vi.mock("./web-runtime.js", () => ({
  qaWebOpenPage: webOpenPage,
  qaWebWait: webWait,
  qaWebType: webType,
  qaWebSnapshot: webSnapshot,
  qaWebEvaluate: webEvaluate,
}));

vi.mock("./cron-run-wait.js", () => ({
  waitForCronRunCompletion,
}));

vi.mock("./discovery-eval.js", () => ({
  hasDiscoveryLabels,
  reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles,
}));

vi.mock("./extract-tool-payload.js", () => ({
  extractQaToolPayload,
}));

vi.mock("./model-switch-eval.js", () => ({
  hasModelSwitchContinuityEvidence,
}));

vi.mock("./runtime-api.js", () => ({
  qaChannelPlugin,
}));

import { createQaSuiteScenarioFlowApi } from "./suite-runtime-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

describe("qa suite runtime flow", () => {
  it("wires the split suite runtime deps into the scenario runtime api", async () => {
    const env = {
      lab: { baseUrl: "http://127.0.0.1:4444" },
      webSessionIds: new Set<string>(),
      gateway: {} as QaSuiteRuntimeEnv["gateway"],
      transport: {
        id: "qa-channel",
        label: "QA Channel",
        accountId: "qa-channel",
        waitReady: vi.fn(),
        createGatewayConfig: vi.fn(),
        buildAgentDelivery: vi.fn(),
        requiredPluginIds: [],
        handleAction: vi.fn(),
        createReportNotes: vi.fn(),
        state: {
          reset: vi.fn(),
          getSnapshot: vi.fn(),
          addInboundMessage: vi.fn(),
          addOutboundMessage: vi.fn(),
          readMessage: vi.fn(),
          searchMessages: vi.fn(),
          waitFor: vi.fn(),
        },
        capabilities: {
          waitForOutboundMessage: vi.fn(),
          waitForCondition: vi.fn(),
          getNormalizedMessageState: vi.fn(),
          resetNormalizedMessageState: vi.fn(),
          sendInboundMessage: vi.fn(),
          injectOutboundMessage: vi.fn(),
          readNormalizedMessage: vi.fn(),
          executeGenericAction: vi.fn(),
          waitForReady: vi.fn(),
          assertNoFailureReplies: vi.fn(),
        },
      },
      repoRoot: "/repo",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5-mini",
      mock: null,
      cfg: {} as QaSuiteRuntimeEnv["cfg"],
    } satisfies Parameters<typeof createQaSuiteScenarioFlowApi>[0]["env"];
    const scenario = {
      id: "session-memory-ranking",
      title: "Session memory ranking",
      sourcePath: "qa/scenarios/session-memory-ranking.md",
      surface: "qa-channel",
      objective: "test",
      successCriteria: ["test"],
      execution: {
        kind: "flow" as const,
        config: { expected: "value" },
        flow: { steps: [] },
      },
    };
    const runScenario = vi.fn();
    const splitModelRef = vi.fn();
    const formatErrorMessage = vi.fn();
    const liveTurnTimeoutMs = vi.fn();
    const resolveQaLiveTurnTimeoutMs = vi.fn();
    createQaScenarioRuntimeApi.mockReturnValue({ api: "ok" });

    const result = createQaSuiteScenarioFlowApi({
      env,
      scenario,
      runScenario,
      splitModelRef,
      formatErrorMessage,
      liveTurnTimeoutMs,
      resolveQaLiveTurnTimeoutMs,
      constants: {
        imageUnderstandingPngBase64: "small",
        imageUnderstandingLargePngBase64: "large",
        imageUnderstandingValidPngBase64: "valid",
      },
    });

    expect(result).toEqual({ api: "ok" });
    expect(createQaScenarioRuntimeApi).toHaveBeenCalledTimes(1);
    const call = createQaScenarioRuntimeApi.mock.calls.at(0)?.[0] as {
      env: typeof env;
      scenario: typeof scenario;
      deps: {
        runScenario: typeof runScenario;
        waitForQaChannelReady: typeof waitForQaChannelReady;
        waitForOutboundMessage: typeof waitForOutboundMessage;
        findManagedDreamingCronJob: typeof findManagedDreamingCronJob;
        forceMemoryIndex: typeof forceMemoryIndex;
        runAgentPrompt: typeof runAgentPrompt;
        qaChannelPlugin: typeof qaChannelPlugin;
        webOpenPage: (params: { url: string }) => Promise<unknown>;
      };
      constants: {
        imageUnderstandingPngBase64: string;
        imageUnderstandingLargePngBase64: string;
        imageUnderstandingValidPngBase64: string;
      };
    };
    expect(call.env).toBe(env);
    expect(call.scenario).toBe(scenario);
    expect(call.deps.runScenario).toBe(runScenario);
    expect(call.deps.waitForQaChannelReady).toBe(waitForQaChannelReady);
    expect(call.deps.waitForOutboundMessage).toBe(waitForOutboundMessage);
    expect(call.deps.findManagedDreamingCronJob).toBe(findManagedDreamingCronJob);
    expect(call.deps.forceMemoryIndex).toBe(forceMemoryIndex);
    expect(call.deps.runAgentPrompt).toBe(runAgentPrompt);
    expect(call.deps.qaChannelPlugin).toBe(qaChannelPlugin);
    expect(call.constants).toEqual({
      imageUnderstandingPngBase64: "small",
      imageUnderstandingLargePngBase64: "large",
      imageUnderstandingValidPngBase64: "valid",
    });

    await call.deps.webOpenPage({ url: "https://openclaw.ai" });
    expect(webOpenPage).toHaveBeenCalledWith({ url: "https://openclaw.ai" });
    expect(env.webSessionIds.has("page-1")).toBe(true);
  });
});
