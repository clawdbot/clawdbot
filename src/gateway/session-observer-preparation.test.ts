import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCompleteModel, defaultPrepareModel } from "./session-observer-model.js";
import {
  createHarness,
  flushObserver,
  preparedModel,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

const runtimeMocks = vi.hoisted(() => ({
  prepareDirect: vi.fn(),
  completeDirect: vi.fn(),
  selectModel: vi.fn(),
  prepareUtility: vi.fn(),
  completeIsolated: vi.fn(),
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent: runtimeMocks.prepareDirect,
  completeWithPreparedSimpleCompletionModel: runtimeMocks.completeDirect,
  resolveSimpleCompletionSelectionForAgent: runtimeMocks.selectModel,
}));
vi.mock("../agents/utility-completion.js", () => ({
  prepareUtilityCompletionForAgent: runtimeMocks.prepareUtility,
}));
vi.mock("../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: runtimeMocks.completeIsolated,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

describe("session observer model preparation", () => {
  it.each(["claude-cli", "anthropic"])(
    "publishes a digest from a runtime-owned %s utility completion after empty output without API auth",
    async (provider) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const config = {
        agents: {
          defaults: {
            utilityModel: `${provider}/claude-sonnet-4-6`,
            models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } } },
          },
        },
      };
      const prepared = {
        config,
        provider,
        model: "claude-sonnet-4-6",
        agentId: "main",
        agentDir: "/tmp/agent",
      };
      runtimeMocks.prepareDirect.mockResolvedValue({
        selection: { provider, modelId: prepared.model, agentDir: prepared.agentDir },
        model: { provider, id: prepared.model, maxTokens: 8192 },
        auth: { apiKey: "openclaw:claude-cli-native-auth", mode: "oauth" },
      });
      runtimeMocks.completeDirect
        .mockReset()
        .mockRejectedValue(new Error("HTTP 401 invalid credential"));
      const { prepareUtilityCompletionForAgent } = await vi.importActual<
        typeof import("../agents/utility-completion.js")
      >("../agents/utility-completion.js");
      runtimeMocks.selectModel.mockReturnValue({
        provider,
        modelId: prepared.model,
        agentDir: prepared.agentDir,
      });
      runtimeMocks.prepareUtility.mockImplementation(prepareUtilityCompletionForAgent);
      const completion = {
        text: JSON.stringify({ headline: "Reviewing the implementation", health: "on-track" }),
        provider: "anthropic",
        model: prepared.model,
        owner: { kind: "cli", id: "claude-cli" },
      };
      runtimeMocks.completeIsolated
        .mockReset()
        .mockImplementationOnce(async (request) => {
          // The isolated owner rejects empty output unless its caller owns visible-text recovery.
          if (request.outputTextPolicy !== "strict-visible") {
            throw new Error("Isolated completion returned empty output.");
          }
          return { ...completion, text: "" };
        })
        .mockResolvedValueOnce(completion);
      const harness = createHarness({
        config,
        utilityModelRef: config.agents.defaults.utilityModel,
        prepareModel: vi.fn(defaultPrepareModel),
        completeModel: vi.fn(defaultCompleteModel),
      });
      startAndAddToolNotes(harness.observer);
      await vi.advanceTimersByTimeAsync(12_000);
      await vi.dynamicImportSettled();
      await flushObserver();

      expect(runtimeMocks.completeDirect).not.toHaveBeenCalled();
      expect(runtimeMocks.completeIsolated).toHaveBeenCalledTimes(2);
      expect(runtimeMocks.completeIsolated).toHaveBeenCalledWith(
        expect.objectContaining({
          ...prepared,
          timeoutMs: 10_000,
          abortSignal: expect.any(AbortSignal),
        }),
      );
      expect(runtimeMocks.completeIsolated.mock.calls[0]?.[0]).not.toHaveProperty("auth");
      expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
        "session.observer",
        expect.objectContaining({ headline: "Reviewing the implementation", health: "on-track" }),
        expect.any(Set),
        expect.anything(),
      );
      harness.observer.dispose();
    },
  );

  it("does not start completion after observation ends during model preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolvePreparation: ((value: ReturnType<typeof preparedModel>) => void) | undefined;
    const prepareModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof preparedModel>>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(prepareModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    resolvePreparation?.(preparedModel());
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("times out stalled model preparation without starting another preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const prepareModel = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved: the observer timeout owns this test path.
        }),
    );
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(34_000);
    await flushObserver();

    expect(prepareModel).toHaveBeenCalledOnce();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("retries after a rejected preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const prepareModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary preparation failure"))
      .mockResolvedValue(preparedModel());
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(24_000);
    await flushObserver();

    expect(prepareModel).toHaveBeenCalledTimes(2);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });
});
