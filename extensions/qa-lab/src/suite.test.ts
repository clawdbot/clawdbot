// Qa Lab tests cover suite plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import { qaSuiteProgressTesting, runQaSuite } from "./suite.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
});

function makeQaSuiteTestLabHandle(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: {} as QaLabServerHandle["state"],
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(async () => ({}) as Awaited<ReturnType<QaLabServerHandle["runSelfCheck"]>>),
    stop: vi.fn(async () => {}),
  };
}

describe("qa suite", () => {
  it("rejects unsupported transport ids before starting the lab", async () => {
    const startLab = vi.fn();

    await expect(
      runQaSuite({
        transportId: "qa-nope" as unknown as "qa-channel",
        startLab,
      }),
    ).rejects.toThrow("unsupported QA transport: qa-nope");

    expect(startLab).not.toHaveBeenCalled();
  });

  it("parses progress env booleans", () => {
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("true")).toBe(true);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("on")).toBe(true);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("false")).toBe(false);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("off")).toBe(false);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("maybe")).toBeUndefined();
  });

  it("stops an owned lab when readiness never becomes healthy", async () => {
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: false },
      release: vi.fn(async () => {}),
    });

    await expect(
      qaSuiteProgressTesting.waitForQaLabReadyOrStopOwned({
        lab: {
          listenUrl: "http://127.0.0.1:43123",
          stop,
        },
        ownsLab: true,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out after 1ms waiting for qa-lab ready");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves caller-owned labs running when readiness never becomes healthy", async () => {
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: false },
      release: vi.fn(async () => {}),
    });

    await expect(
      qaSuiteProgressTesting.waitForQaLabReadyOrStopOwned({
        lab: {
          listenUrl: "http://127.0.0.1:43123",
          stop,
        },
        ownsLab: false,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out after 1ms waiting for qa-lab ready");
    expect(stop).not.toHaveBeenCalled();
  });

  it("defaults progress logging from CI when no override is set", () => {
    expect(qaSuiteProgressTesting.shouldLogQaSuiteProgress({ CI: "true" })).toBe(true);
    expect(qaSuiteProgressTesting.shouldLogQaSuiteProgress({ CI: "false" })).toBe(false);
  });

  it("resolves transport-ready timeout from params and env", () => {
    expect(qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {})).toBe(
      120_000,
    );
    expect(
      qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "180000",
      }),
    ).toBe(180_000);
    expect(
      qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "bad",
      }),
    ).toBe(120_000);
    for (const value of ["0x10", "1e3", "10.5"]) {
      expect(
        qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {
          OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: value,
        }),
      ).toBe(120_000);
    }
    expect(qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(90_000, {})).toBe(90_000);
  });

  it("applies OPENCLAW_QA_SUITE_PROGRESS override and falls back on invalid values", () => {
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "true",
      }),
    ).toBe(true);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "false",
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "on",
      }),
    ).toBe(true);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "off",
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "definitely",
      }),
    ).toBe(true);
  });

  it("sanitizes scenario ids for progress logs", () => {
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("scenario-id")).toBe("scenario-id");
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("scenario\nid\tvalue")).toBe(
      "scenario id value",
    );
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("\u0000\u0001")).toBe("<empty>");
  });

  it("records gateway RSS peak and trace samples", () => {
    expect(
      qaSuiteProgressTesting.buildQaSuiteRuntimeMetrics({
        startedAt: new Date("2026-04-22T12:00:00.000Z"),
        finishedAt: new Date("2026-04-22T12:00:12.000Z"),
        gatewayProcessCpuStartMs: 1_000,
        gatewayProcessCpuEndMs: 4_000,
        gatewayProcessRssStartBytes: 100_000_000,
        gatewayProcessRssEndBytes: 125_000_000,
        gatewayProcessRssSamples: [
          {
            label: "suite-start",
            at: "2026-04-22T12:00:00.000Z",
            gatewayProcessRssBytes: 100_000_000,
          },
          {
            label: "scenario:canary:finish",
            at: "2026-04-22T12:00:10.000Z",
            gatewayProcessRssBytes: 140_000_000,
          },
        ],
        gatewayHeapSnapshots: [
          {
            label: "suite-start",
            at: "2026-04-22T12:00:01.000Z",
            path: "artifacts/gateway-heap-snapshots/suite-start.heapsnapshot",
            bytes: 12_345,
          },
        ],
      }),
    ).toEqual({
      wallMs: 12_000,
      gatewayProcessCpuMs: 3_000,
      gatewayCpuCoreRatio: 0.25,
      gatewayProcessRssStartBytes: 100_000_000,
      gatewayProcessRssEndBytes: 125_000_000,
      gatewayProcessRssDeltaBytes: 25_000_000,
      gatewayProcessRssPeakBytes: 140_000_000,
      gatewayProcessRssPeakDeltaBytes: 40_000_000,
      gatewayProcessRssSamples: [
        {
          label: "suite-start",
          at: "2026-04-22T12:00:00.000Z",
          gatewayProcessRssBytes: 100_000_000,
        },
        {
          label: "scenario:canary:finish",
          at: "2026-04-22T12:00:10.000Z",
          gatewayProcessRssBytes: 140_000_000,
        },
      ],
      gatewayHeapSnapshots: [
        {
          label: "suite-start",
          at: "2026-04-22T12:00:01.000Z",
          path: "artifacts/gateway-heap-snapshots/suite-start.heapsnapshot",
          bytes: 12_345,
        },
      ],
    });
  });

  it("arms gateway heap checkpoint env only when requested", () => {
    expect(
      qaSuiteProgressTesting.buildQaGatewayHeapCheckpointRuntimeEnvPatch({
        OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS: "0",
      }),
    ).toBeUndefined();
    expect(
      qaSuiteProgressTesting.buildQaGatewayHeapCheckpointRuntimeEnvPatch({
        OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS: "1",
        NODE_OPTIONS: "--max-old-space-size=4096",
      }),
    ).toEqual({
      NODE_OPTIONS: "--max-old-space-size=4096 --heapsnapshot-signal=SIGUSR2",
    });
    expect(
      qaSuiteProgressTesting.mergeQaRuntimeEnvPatches(
        { OPENAI_API_KEY: "mock" },
        { NODE_OPTIONS: "--heapsnapshot-signal=SIGUSR2" },
      ),
    ).toEqual({
      OPENAI_API_KEY: "mock",
      NODE_OPTIONS: "--heapsnapshot-signal=SIGUSR2",
    });
  });

  it("builds a codex mock runtime env patch that stays on the QA mock provider", () => {
    expect(
      qaSuiteProgressTesting.buildQaRuntimeEnvPatch({
        providerMode: "mock-openai",
        forcedRuntime: "codex",
        mockBaseUrl: "http://127.0.0.1:44080",
      }),
    ).toEqual({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "codex",
      OPENCLAW_CODEX_APP_SERVER_ARGS:
        "app-server -c openai_base_url=http://127.0.0.1:44080/v1 --listen stdio://",
      OPENAI_API_KEY: "qa-mock-openai-key",
      CODEX_API_KEY: "qa-mock-openai-key",
    });
  });

  it("omits mock OpenAI rewiring for non-codex runtime overrides", () => {
    expect(
      qaSuiteProgressTesting.buildQaRuntimeEnvPatch({
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
        mockBaseUrl: "http://127.0.0.1:44080",
      }),
    ).toEqual({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "openclaw",
    });
  });

  it("forwards run options into isolated scenario worker params", () => {
    const startLab = vi.fn();
    const scenario = makeQaSuiteTestScenario("patched-control-ui", {
      surface: "control-ui",
      gatewayConfigPatch: {
        messages: {
          groupChat: {
            visibleReplies: "message_tool",
          },
        },
      },
    });

    expect(
      qaSuiteProgressTesting.buildQaIsolatedScenarioWorkerParams({
        repoRoot: "/repo",
        outputDir: "/repo/.artifacts/qa-e2e/scenarios/patched-control-ui",
        providerMode: "mock-openai",
        transportId: "qa-channel",
        primaryModel: "mock-openai/gpt-5.5",
        alternateModel: "mock-openai/gpt-5.5-alt",
        fastMode: true,
        scenario,
        startLab,
        input: {
          thinkingDefault: "minimal",
          claudeCliAuthMode: "subscription",
          enabledPluginIds: ["acpx"],
          transportReadyTimeoutMs: 180_000,
          forcedRuntime: "codex",
        },
      }),
    ).toMatchObject({
      scenarioIds: ["patched-control-ui"],
      concurrency: 1,
      startLab,
      controlUiEnabled: true,
      thinkingDefault: "minimal",
      claudeCliAuthMode: "subscription",
      enabledPluginIds: ["acpx"],
      transportReadyTimeoutMs: 180_000,
      forcedRuntime: "codex",
    });
  });

  it("enables Control UI only for Control UI scenarios unless explicitly overridden", () => {
    const channelScenario = makeQaSuiteTestScenario("channel-baseline", { surface: "channel" });
    const controlUiScenario = makeQaSuiteTestScenario("control-ui-roundtrip", {
      surface: "control-ui",
    });

    expect(
      qaSuiteProgressTesting.resolveQaSuiteControlUiEnabled({
        scenarios: [channelScenario],
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.resolveQaSuiteControlUiEnabled({
        scenarios: [channelScenario, controlUiScenario],
      }),
    ).toBe(true);
    expect(
      qaSuiteProgressTesting.resolveQaSuiteControlUiEnabled({
        explicit: true,
        scenarios: [channelScenario],
      }),
    ).toBe(true);
  });

  it("keeps caller-owned serial labs on shared workers without a launcher", () => {
    const scenarios = [
      makeQaSuiteTestScenario("baseline"),
      makeQaSuiteTestScenario("message-tool-mode", {
        gatewayConfigPatch: {
          messages: {
            groupChat: {
              visibleReplies: "message_tool",
            },
          },
        },
      }),
    ];
    const lab = makeQaSuiteTestLabHandle();
    const startLab = vi.fn();

    expect(
      qaSuiteProgressTesting.shouldRunQaSuiteWithIsolatedScenarioWorkers({
        scenarios,
        concurrency: 1,
        lab,
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.shouldRunQaSuiteWithIsolatedScenarioWorkers({
        scenarios,
        concurrency: 1,
        lab,
        startLab,
      }),
    ).toBe(true);
  });

  it("remaps mock-openai model refs onto the app-server OpenAI provider for codex cells only", () => {
    expect(
      qaSuiteProgressTesting.remapModelRefForForcedRuntime({
        modelRef: "mock-openai/gpt-5.5",
        providerMode: "mock-openai",
        forcedRuntime: "codex",
      }),
    ).toBe("openai/gpt-5.5");
    expect(
      qaSuiteProgressTesting.remapModelRefForForcedRuntime({
        modelRef: "mock-openai/gpt-5.5",
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
      }),
    ).toBe("mock-openai/gpt-5.5");
  });
});
