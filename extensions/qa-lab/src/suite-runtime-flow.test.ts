// Qa Lab tests cover suite runtime flow plugin behavior.
import { parseModelRef, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createQaScenarioRuntimeApi = vi.hoisted(() => vi.fn());
const runScenarioFlow = vi.hoisted(() => vi.fn(async (params: { api: unknown }) => params.api));
const waitForOutboundMessage = vi.hoisted(() => vi.fn());
const runRuntimeToolFixture = vi.hoisted(() => vi.fn());
const webOpenPage = vi.hoisted(() => vi.fn(async () => ({ pageId: "page-1" })));

vi.mock("./scenario-runtime-api.js", () => ({
  createQaScenarioRuntimeApi,
}));

vi.mock("./scenario-flow-runner.js", () => ({
  runScenarioFlow,
}));

vi.mock("./suite-runtime-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-runtime-transport.js")>()),
  waitForOutboundMessage,
}));

vi.mock("./web-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./web-runtime.js")>()),
  qaWebOpenPage: webOpenPage,
}));

vi.mock("./runtime-tool-fixture.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-tool-fixture.js")>()),
  runRuntimeToolFixture,
}));

import * as browserRuntime from "./browser-runtime.js";
import * as cronRunWait from "./cron-run-wait.js";
import * as discoveryEval from "./discovery-eval.js";
import { QaSuiteScenarioSkipError } from "./errors.js";
import * as extractToolPayload from "./extract-tool-payload.js";
import * as modelSwitchEval from "./model-switch-eval.js";
import type { QaScenarioRuntimeDeps } from "./scenario-runtime-api.js";
import * as suiteRuntimeAgent from "./suite-runtime-agent.js";
import { runQaSuiteScenarioDefinition, runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import * as suiteRuntimeGateway from "./suite-runtime-gateway.js";
import * as suiteRuntimeTransport from "./suite-runtime-transport.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import * as webRuntime from "./web-runtime.js";

const qaSuiteRuntimeFlowTestConstants = {
  imageUnderstandingPngBase64: "small",
  imageUnderstandingLargePngBase64: "large",
  imageUnderstandingValidPngBase64: "valid",
};

function createQaSuiteRuntimeFlowTestEnv(
  transportOverrides: Partial<QaSuiteRuntimeEnv["transport"]> = {},
) {
  return {
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
      supportedActions: [],
      handleAction: vi.fn(),
      createReportNotes: vi.fn(),
      reset: vi.fn(),
      sendInbound: vi.fn(),
      sendNativeCommand: vi.fn(),
      waitForNoOutbound: vi.fn(),
      waitForOutbound: vi.fn(),
      waitForOutboundSequence: vi.fn(),
      state: {
        reset: vi.fn(),
        getSnapshot: vi.fn(),
        addInboundMessage: vi.fn(),
        addOutboundMessage: vi.fn(),
        readMessage: vi.fn(),
        searchMessages: vi.fn(),
        waitFor: vi.fn(),
      },
      waitForCondition: vi.fn(),
      ...transportOverrides,
    },
    outputDir: "/artifacts",
    repoRoot: "/repo",
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    mock: null,
    cfg: {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-5": { alias: "opus" },
          },
        },
      },
    },
  } satisfies Parameters<typeof runQaSuiteScenarioDefinition>[0]["env"];
}

describe("qa suite runtime flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records intentional scenario skips without running later steps", async () => {
    const laterStep = vi.fn();
    const result = await runQaSuiteScenarioSteps("requires group credentials", [
      {
        name: "Prepare WhatsApp",
        run: async () => {
          throw new QaSuiteScenarioSkipError("requires groupJid in the credential payload");
        },
      },
      { name: "Run scenario", run: laterStep },
    ]);

    expect(result).toMatchObject({
      status: "skip",
      details: "requires groupJid in the credential payload",
      steps: [
        {
          name: "Prepare WhatsApp",
          status: "skip",
          details: "requires groupJid in the credential payload",
        },
      ],
    });
    expect(laterStep).not.toHaveBeenCalled();
  });

  it("wires the split suite runtime deps into the scenario runtime api", async () => {
    const env = createQaSuiteRuntimeFlowTestEnv();
    const scenario = {
      id: "session-memory-ranking",
      title: "Session memory ranking",
      sourcePath: "qa/scenarios/session-memory-ranking.yaml",
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
    const splitModelRef = vi.fn((raw: string) => parseModelRef(raw, "openai"));
    const formatErrorMessage = vi.fn();
    const liveTurnTimeoutMs = vi.fn(() => 60_000);
    const resolveQaLiveTurnTimeoutMs = vi.fn();
    createQaScenarioRuntimeApi.mockReturnValue({ api: "ok" });

    const result = await runQaSuiteScenarioDefinition({
      env,
      scenario,
      runScenario,
      splitModelRef,
      formatErrorMessage,
      liveTurnTimeoutMs,
      resolveQaLiveTurnTimeoutMs,
      constants: qaSuiteRuntimeFlowTestConstants,
    });

    expect(result).toMatchObject({ api: "ok", signal: expect.any(AbortSignal) });
    expect(createQaScenarioRuntimeApi).toHaveBeenCalledTimes(1);
    const call = createQaScenarioRuntimeApi.mock.calls[0]?.[0] as {
      env: typeof env;
      scenario: typeof scenario;
      deps: QaScenarioRuntimeDeps & {
        waitForOutboundMessage: typeof waitForOutboundMessage;
        markGatewayLogCursor: () => number;
        assertNoGatewayLogSentinels: () => void;
        runRuntimeToolFixture: (
          envArg: typeof env,
          configArg: Record<string, unknown>,
        ) => Promise<unknown>;
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
    expect(call.deps.runScenario).toBeTypeOf("function");
    for (const dependencyModule of [
      suiteRuntimeAgent,
      suiteRuntimeGateway,
      cronRunWait,
      discoveryEval,
      extractToolPayload,
      modelSwitchEval,
    ]) {
      for (const [name, helper] of Object.entries(dependencyModule)) {
        expect((call.deps as Record<string, unknown>)[name]).toBe(helper);
      }
    }
    for (const [name, helper] of Object.entries(suiteRuntimeTransport)) {
      if (name !== "waitForOutboundMessage") {
        expect((call.deps as Record<string, unknown>)[name]).toBe(helper);
      }
    }
    const aliasedDependencies = {
      browserRequest: browserRuntime.callQaBrowserRequest,
      waitForBrowserReady: browserRuntime.waitForQaBrowserReady,
      browserOpenTab: browserRuntime.qaBrowserOpenTab,
      browserSnapshot: browserRuntime.qaBrowserSnapshot,
      browserAct: browserRuntime.qaBrowserAct,
      webWait: webRuntime.qaWebWait,
      webType: webRuntime.qaWebType,
      webSnapshot: webRuntime.qaWebSnapshot,
      webEvaluate: webRuntime.qaWebEvaluate,
    };
    for (const [name, helper] of Object.entries(aliasedDependencies)) {
      expect((call.deps as Record<string, unknown>)[name]).toBe(helper);
    }
    const canonicalOpus = resolveModelRefFromString({
      cfg: env.cfg,
      raw: "anthropic/opus",
      defaultProvider: "anthropic",
    })?.ref;
    const normalizeModelRef = call.deps.normalizeModelRef as (
      raw: string,
    ) => { provider: string; model: string } | null;
    expect(canonicalOpus).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    expect(normalizeModelRef("anthropic/opus")).toEqual(canonicalOpus);
    expect(normalizeModelRef("AnThRoPiC/OPUS")).toEqual(canonicalOpus);
    expect(normalizeModelRef("OPENAI/gpt-5.6-luna")).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(normalizeModelRef("")).toBeNull();
    expect(call.deps.waitForOutboundMessage).toBeTypeOf("function");
    const outboundPredicate = vi.fn();
    call.deps.waitForOutboundMessage(env.transport.state, outboundPredicate, 123);
    expect(waitForOutboundMessage).toHaveBeenCalledWith(
      env.transport.state,
      outboundPredicate,
      123,
      { accountId: "qa-channel" },
    );
    expect(call.deps.markGatewayLogCursor()).toBe(0);
    expect(() => call.deps.assertNoGatewayLogSentinels()).not.toThrow();
    await call.deps.runRuntimeToolFixture(env, { toolName: "read" });
    expect(runRuntimeToolFixture).toHaveBeenCalledWith(
      env,
      { toolName: "read" },
      {
        createSession: suiteRuntimeAgent.createSession,
        readEffectiveTools: suiteRuntimeAgent.readEffectiveTools,
        runAgentPrompt: suiteRuntimeAgent.runAgentPrompt,
        fetchJson: suiteRuntimeGateway.fetchJson,
        ensureImageGenerationConfigured: suiteRuntimeAgent.ensureImageGenerationConfigured,
      },
    );
    expect(call.constants).toEqual({
      imageUnderstandingPngBase64: "small",
      imageUnderstandingLargePngBase64: "large",
      imageUnderstandingValidPngBase64: "valid",
    });

    await call.deps.webOpenPage({ url: "https://openclaw.ai" });
    expect(webOpenPage).toHaveBeenCalledWith({ url: "https://openclaw.ai", repoRoot: "/repo" });
    expect(env.webSessionIds.has("page-1")).toBe(true);
  });

  it("records live transport preparation as the first shared flow step", async () => {
    const prepareFlow = vi.fn(async () => {
      throw new Error("setup failed");
    });
    const env = createQaSuiteRuntimeFlowTestEnv({
      label: "Matrix live",
      prepareFlow,
    });
    const scenario = makeQaSuiteTestScenario("matrix-preparation-failure", {
      channel: "matrix",
      config: { expected: "value" },
    });
    if (scenario.execution.kind !== "flow") {
      throw new Error("expected flow scenario");
    }
    scenario.execution.timeoutMs = 45_000;
    const runScenario = vi.fn(runQaSuiteScenarioSteps);

    createQaScenarioRuntimeApi.mockReturnValueOnce({ api: "ok" });
    await runQaSuiteScenarioDefinition({
      env,
      scenario,
      runScenario,
      splitModelRef: (raw) => parseModelRef(raw, "openai"),
      formatErrorMessage: (error) => String(error),
      liveTurnTimeoutMs: () => 60_000,
      resolveQaLiveTurnTimeoutMs: () => 60_000,
      constants: qaSuiteRuntimeFlowTestConstants,
    });

    expect(createQaScenarioRuntimeApi).toHaveBeenCalledTimes(1);
    const capturedCall = createQaScenarioRuntimeApi.mock.calls[0]?.[0];
    if (!capturedCall) {
      throw new Error("expected QA scenario runtime API call");
    }
    const capturedDeps = (
      capturedCall as {
        deps: {
          runScenario: Parameters<typeof runQaSuiteScenarioDefinition>[0]["runScenario"];
        };
      }
    ).deps;
    const scenarioStep = vi.fn(async () => "not reached");
    await expect(
      capturedDeps.runScenario("Matrix preparation", [{ name: "Scenario", run: scenarioStep }]),
    ).resolves.toEqual({
      name: "Matrix preparation",
      status: "fail",
      steps: [{ name: "Prepare Matrix live", status: "fail", details: "setup failed" }],
      details: "setup failed",
    });

    expect(runScenario).toHaveBeenCalledWith("Matrix preparation", [
      { name: "Prepare Matrix live", run: expect.any(Function) },
      { name: "Scenario", run: expect.any(Function) },
    ]);
    expect(prepareFlow).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      config: { expected: "value" },
      gateway: env.gateway,
      outputDir: "/artifacts",
      primaryModel: "openai/gpt-5.6-luna",
      scenarioId: "matrix-preparation-failure",
      scenarioTitle: "matrix-preparation-failure",
      timeoutMs: 45_000,
      waitForConfigRestartSettle: expect.any(Function),
    });
    expect(scenarioStep).not.toHaveBeenCalled();
  });

  it("does not turn the preparation fallback into a whole-flow deadline", async () => {
    const prepareFlow = vi.fn(async () => undefined);
    const env = createQaSuiteRuntimeFlowTestEnv({ prepareFlow });
    const scenario = makeQaSuiteTestScenario("flow-without-explicit-deadline", { config: {} });
    const liveTurnTimeoutMs = vi.fn(() => 5);
    createQaScenarioRuntimeApi.mockImplementationOnce(
      (params: { deps: { runScenario: typeof runQaSuiteScenarioSteps } }) => ({
        runScenario: params.deps.runScenario,
      }),
    );
    runScenarioFlow.mockImplementationOnce(async (params) => {
      const api = params.api as { runScenario: typeof runQaSuiteScenarioSteps };
      return await api.runScenario("No explicit deadline", [
        {
          name: "Longer than preparation fallback",
          run: async () => {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 20);
            });
          },
        },
      ]);
    });

    const result = await runQaSuiteScenarioDefinition({
      env,
      scenario,
      runScenario: runQaSuiteScenarioSteps,
      splitModelRef: (raw) => parseModelRef(raw, "openai"),
      formatErrorMessage: (error) => String(error),
      liveTurnTimeoutMs,
      resolveQaLiveTurnTimeoutMs: liveTurnTimeoutMs,
      constants: qaSuiteRuntimeFlowTestConstants,
    });

    expect(result.status).toBe("pass");
    expect(liveTurnTimeoutMs).toHaveBeenCalledOnce();
    expect(prepareFlow).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 5 }),
    );
  });

  it("bounds preparation and actions with one aborting scenario deadline", async () => {
    let preparationSignal: AbortSignal | undefined;
    let actionSignal: AbortSignal | undefined;
    const prepareFlow = vi.fn(async (input: { signal?: AbortSignal }) => {
      preparationSignal = input.signal;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    });
    const env = createQaSuiteRuntimeFlowTestEnv({ prepareFlow });
    const scenario = makeQaSuiteTestScenario("flow-deadline", { config: {} });
    if (scenario.execution.kind !== "flow") {
      throw new Error("expected flow scenario");
    }
    scenario.execution.timeoutMs = 30;
    createQaScenarioRuntimeApi.mockImplementationOnce(
      (params: { deps: { runScenario: typeof runQaSuiteScenarioSteps } }) => ({
        runScenario: params.deps.runScenario,
      }),
    );
    runScenarioFlow.mockImplementationOnce(async (params) => {
      const api = params.api as {
        runScenario: typeof runQaSuiteScenarioSteps;
        signal?: AbortSignal;
      };
      return await api.runScenario("Flow deadline", [
        {
          name: "Never settles without abort",
          run: async () =>
            await new Promise<void>(() => {
              actionSignal = api.signal;
              api.signal?.addEventListener("abort", () => {}, { once: true });
            }),
        },
      ]);
    });

    let boundedTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      runQaSuiteScenarioDefinition({
        env,
        scenario,
        runScenario: runQaSuiteScenarioSteps,
        splitModelRef: (raw) => parseModelRef(raw, "openai"),
        formatErrorMessage: (error) => String(error),
        liveTurnTimeoutMs: () => 60_000,
        resolveQaLiveTurnTimeoutMs: () => 60_000,
        constants: qaSuiteRuntimeFlowTestConstants,
      }),
      new Promise<"bounded-window-expired">((resolve) => {
        boundedTimer = setTimeout(() => resolve("bounded-window-expired"), 250);
      }),
    ]);
    clearTimeout(boundedTimer);

    expect(result).not.toBe("bounded-window-expired");
    expect(result).toMatchObject({ status: "fail", details: expect.stringContaining("30ms") });
    expect(preparationSignal).toBe(actionSignal);
    expect(actionSignal?.aborted).toBe(true);
  });
});
