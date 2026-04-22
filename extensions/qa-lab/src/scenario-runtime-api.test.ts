import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  createQaScenarioRuntimeApi,
  type QaScenarioRuntimeConstants,
  type QaScenarioRuntimeDeps,
} from "./scenario-runtime-api.js";

function createDeps(overrides?: Partial<QaScenarioRuntimeDeps>): QaScenarioRuntimeDeps {
  const fn = vi.fn();
  return {
    fs,
    path,
    sleep: vi.fn(async () => undefined),
    randomUUID,
    runScenario: fn,
    waitForOutboundMessage: fn,
    waitForTransportOutboundMessage: fn,
    waitForChannelOutboundMessage: fn,
    waitForNoOutbound: fn,
    waitForNoTransportOutbound: fn,
    recentOutboundSummary: fn,
    formatConversationTranscript: fn,
    readTransportTranscript: fn,
    formatTransportTranscript: fn,
    fetchJson: fn,
    waitForGatewayHealthy: fn,
    waitForTransportReady: fn,
    waitForQaChannelReady: fn,
    browserRequest: fn,
    waitForBrowserReady: fn,
    browserOpenTab: fn,
    browserSnapshot: fn,
    browserAct: fn,
    webOpenPage: fn,
    webWait: fn,
    webType: fn,
    webSnapshot: fn,
    webEvaluate: fn,
    waitForConfigRestartSettle: fn,
    patchConfig: fn,
    applyConfig: fn,
    readConfigSnapshot: fn,
    createSession: fn,
    readEffectiveTools: fn,
    readSkillStatus: fn,
    readRawQaSessionStore: fn,
    runQaCli: fn,
    extractMediaPathFromText: fn,
    resolveGeneratedImagePath: fn,
    startAgentRun: fn,
    waitForAgentRun: fn,
    listCronJobs: fn,
    waitForCronRunCompletion: fn,
    readDoctorMemoryStatus: fn,
    forceMemoryIndex: fn,
    findSkill: fn,
    writeWorkspaceSkill: fn,
    callPluginToolsMcp: fn,
    runAgentPrompt: fn,
    ensureImageGenerationConfigured: fn,
    handleQaAction: fn,
    extractQaToolPayload: fn,
    formatMemoryDreamingDay: fn,
    resolveSessionTranscriptsDirForAgent: fn,
    buildAgentSessionKey: fn,
    normalizeLowercaseStringOrEmpty: fn,
    formatErrorMessage: fn,
    liveTurnTimeoutMs: fn,
    resolveQaLiveTurnTimeoutMs: fn,
    splitModelRef: fn,
    qaChannelPlugin: { id: "qa-channel" },
    hasDiscoveryLabels: fn,
    reportsDiscoveryScopeLeak: fn,
    reportsMissingDiscoveryFiles: fn,
    hasModelSwitchContinuityEvidence: fn,
    ...overrides,
  };
}

const constants: QaScenarioRuntimeConstants = {
  imageUnderstandingPngBase64: "png-small",
  imageUnderstandingLargePngBase64: "png-large",
  imageUnderstandingValidPngBase64: "png-valid",
};

describe("createQaScenarioRuntimeApi", () => {
  it("builds a markdown-flow runtime surface from generic transport capabilities", async () => {
    const state = createQaBusState();
    const resetSpy = vi.spyOn(state, "reset");
    const inboundSpy = vi.spyOn(state, "addInboundMessage");
    const outboundSpy = vi.spyOn(state, "addOutboundMessage");
    const readSpy = vi.spyOn(state, "readMessage");
    const waitForCondition = vi.fn(async (check: () => unknown) => check());
    const sleep = vi.fn(async () => undefined);
    const env = {
      lab: { baseUrl: "http://127.0.0.1:1234" },
      transport: {
        state,
        capabilities: {
          waitForCondition,
          getNormalizedMessageState: state.getSnapshot.bind(state),
          resetNormalizedMessageState: async () => {
            state.reset();
          },
          sendInboundMessage: state.addInboundMessage.bind(state),
          injectOutboundMessage: state.addOutboundMessage.bind(state),
          readNormalizedMessage: state.readMessage.bind(state),
        },
      },
    };
    const scenario = {
      id: "generic-flow",
      title: "Generic Flow",
      surface: "test",
      objective: "test",
      successCriteria: ["works"],
      sourcePath: "qa/scenarios/generic-flow.md",
      execution: {
        kind: "flow" as const,
        config: { expected: "value" },
        flow: {
          steps: [{ name: "noop", actions: [{ assert: "true" }] }],
        },
      },
    };

    const api = createQaScenarioRuntimeApi({
      env,
      scenario,
      deps: createDeps({ sleep }),
      constants,
    });

    expect(api.lab).toBe(env.lab);
    expect(api.state).toBe(state);
    expect(api.config).toEqual({ expected: "value" });
    expect(api.waitForCondition).toBe(waitForCondition);
    expect(api.waitForChannelReady).toBe(api.waitForTransportReady);
    expect(api.browserRequest).toBeDefined();
    expect(api.waitForBrowserReady).toBeDefined();
    expect(api.browserOpenTab).toBeDefined();
    expect(api.browserSnapshot).toBeDefined();
    expect(api.browserAct).toBeDefined();
    expect(api.webOpenPage).toBeDefined();
    expect(api.webWait).toBeDefined();
    expect(api.webType).toBeDefined();
    expect(api.webSnapshot).toBeDefined();
    expect(api.webEvaluate).toBeDefined();
    expect(api.getTransportSnapshot()).toEqual(state.getSnapshot());
    expect(api.imageUnderstandingPngBase64).toBe("png-small");

    const inbound = api.injectInboundMessage({
      accountId: "qa-channel",
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "qa-operator",
      text: "hello",
    });
    const outbound = api.injectOutboundMessage({
      accountId: "qa-channel",
      to: "dm:qa-operator",
      text: "hi",
    });
    expect(inbound.id).toBeTruthy();
    expect(outbound.id).toBeTruthy();
    api.readTransportMessage({ accountId: "qa-channel", messageId: outbound.id });
    await api.reset();
    await api.resetBus();
    await api.resetTransport();

    expect(inboundSpy).toHaveBeenCalledTimes(1);
    expect(outboundSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
