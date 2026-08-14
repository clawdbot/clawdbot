// Qa Lab tests cover suite runtime flow plugin behavior.
import { parseModelRef, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it, vi } from "vitest";

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
import * as webRuntime from "./web-runtime.js";

describe("qa suite runtime flow", () => {
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
    const liveTurnTimeoutMs = vi.fn();
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
      constants: {
        imageUnderstandingPngBase64: "small",
        imageUnderstandingLargePngBase64: "large",
        imageUnderstandingValidPngBase64: "valid",
      },
    });

    expect(result).toEqual({ api: "ok" });
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
    expect(call.deps.runScenario).toBe(runScenario);
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
});
