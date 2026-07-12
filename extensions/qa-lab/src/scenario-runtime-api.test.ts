// Qa Lab tests cover scenario runtime api plugin behavior.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaTransportAdapter } from "./qa-transport.js";
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
    restartGatewayWithConfigPatch: fn,
    createSession: fn,
    readEffectiveTools: fn,
    readSkillStatus: fn,
    readRawQaSessionStore: fn,
    readGatewayLogs: fn,
    markGatewayLogCursor: fn,
    scanGatewayLogSentinels: fn,
    assertNoGatewayLogSentinels: fn,
    readSessionTranscriptSummary: fn,
    runQaCli: fn,
    extractMediaPathFromText: fn,
    resolveGeneratedImagePath: fn,
    startAgentRun: fn,
    waitForAgentRun: fn,
    waitForAgentHistoryReply: fn,
    listCronJobs: fn,
    waitForCronRunCompletion: fn,
    findManagedDreamingCronJob: fn,
    readDoctorMemoryStatus: fn,
    forceMemoryIndex: fn,
    findSkill: fn,
    writeWorkspaceSkill: fn,
    callPluginToolsMcp: fn,
    runAgentPrompt: fn,
    ensureImageGenerationConfigured: fn,
    handleQaAction: fn,
    runRuntimeToolFixture: fn,
    extractQaToolPayload: fn,
    formatMemoryDreamingDay: fn,
    resolveSessionTranscriptsDirForAgent: fn,
    activeMemoryToggleKey: fn,
    setActiveMemorySessionDisabled: fn,
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
    hasModelSwitchContinuitySignal: fn,
    ...overrides,
  };
}

const constants: QaScenarioRuntimeConstants = {
  imageUnderstandingPngBase64: "png-small",
  imageUnderstandingLargePngBase64: "png-large",
  imageUnderstandingValidPngBase64: "png-valid",
};

const browserAndWebRuntimeTools = [
  "browserRequest",
  "waitForBrowserReady",
  "browserOpenTab",
  "browserSnapshot",
  "browserAct",
  "webOpenPage",
  "webWait",
  "webType",
  "webSnapshot",
  "webEvaluate",
] as const;

describe("createQaScenarioRuntimeApi", () => {
  it("builds a markdown-flow runtime surface from the transport adapter", async () => {
    const state = createQaBusState();
    const resetSpy = vi.spyOn(state, "reset");
    const inboundSpy = vi.spyOn(state, "addInboundMessage");
    const outboundSpy = vi.spyOn(state, "addOutboundMessage");
    const readSpy = vi.spyOn(state, "readMessage");
    const waitForCondition: QaTransportAdapter["waitForCondition"] = async <T>(
      check: () => T | Promise<T | null | undefined> | null | undefined,
    ): Promise<T> => {
      const value = await check();
      if (value === null || value === undefined) {
        throw new Error("waitForCondition test check did not return a value");
      }
      return value;
    };
    const sleep = vi.fn(async () => undefined);
    const env = {
      lab: { baseUrl: "http://127.0.0.1:1234" },
      transport: {
        state,
        reset: async () => {
          state.reset();
        },
        sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
          state.addInboundMessage(input),
        sendNativeCommand: async (
          input: Omit<Parameters<typeof state.addInboundMessage>[0], "nativeCommand" | "text"> & {
            command: string;
          },
        ) => {
          const { command, ...message } = input;
          state.addInboundMessage({
            ...message,
            text: `/${command}`,
            nativeCommand: { name: command },
          });
        },
        waitForNoOutbound: vi.fn(async () => undefined),
        waitForOutbound: vi.fn(async () => {
          throw new Error("not used");
        }),
        waitForOutboundSequence: vi.fn(async () => {
          throw new Error("not used");
        }),
        waitForCondition,
      },
    };
    const scenario = {
      id: "generic-flow",
      title: "Generic Flow",
      surface: "test",
      objective: "test",
      successCriteria: ["works"],
      sourcePath: "qa/scenarios/generic-flow.yaml",
      execution: {
        kind: "flow" as const,
        config: { expected: "value" },
        flow: {
          steps: [{ name: "noop", actions: [{ assert: "true" }] }],
        },
      },
    };
    const deps = createDeps({ sleep });

    const api = createQaScenarioRuntimeApi({
      env,
      scenario,
      deps,
      constants,
    });

    expect(api.lab).toBe(env.lab);
    expect(api.state).toBe(state);
    expect(api.config).toEqual({ expected: "value" });
    expect(api.waitForCondition).toBe(waitForCondition);
    expect(api.waitForChannelReady).toBe(api.waitForTransportReady);
    expect(api.waitForAgentHistoryReply).toBe(deps.waitForAgentHistoryReply);
    expect(api.markGatewayLogCursor).toBe(deps.markGatewayLogCursor);
    expect(api.assertNoGatewayLogSentinels).toBe(deps.assertNoGatewayLogSentinels);
    expect(api.readSessionTranscriptSummary).toBe(deps.readSessionTranscriptSummary);
    for (const toolName of browserAndWebRuntimeTools) {
      expect(api[toolName]).toBe(deps[toolName]);
    }
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
    expect(inbound.id.trim()).not.toBe("");
    expect(outbound.id.trim()).not.toBe("");
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
