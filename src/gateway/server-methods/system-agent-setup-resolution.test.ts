// OpenClaw setup resolution tests cover terminal provider guidance.
import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WizardNextParams,
  WizardNextResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { WizardNextResultSchema } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { createRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildPluginCapabilityConsentReview } from "../../plugins/capability-summary.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SetupInferenceActivationIndeterminateError } from "../../system-agent/setup-inference-core.js";
import type { ActivateSetupInferenceParams } from "../../system-agent/setup-inference.js";
import { createPluginCapabilityConsentPrompter } from "../../wizard/plugin-capability-consent.js";
import { WizardSession } from "../../wizard/session.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const setupInferenceMocks = vi.hoisted(() => ({ activateSetupInference: vi.fn() }));
const providerAuthChoiceMocks = vi.hoisted(() => ({
  prepareAuthChoiceLoadedPluginProvider: vi.fn(),
}));
const setupSharedMocks = vi.hoisted(() => ({
  readSetupConfigFileSnapshot: vi.fn(),
  writeWizardConfigFile: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
}));
vi.mock("../../plugins/provider-auth-choice.js", () => ({
  prepareAuthChoiceLoadedPluginProvider:
    providerAuthChoiceMocks.prepareAuthChoiceLoadedPluginProvider,
}));
vi.mock("../../wizard/setup.shared.js", () => ({
  readSetupConfigFileSnapshot: setupSharedMocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: setupSharedMocks.writeWizardConfigFile,
}));

const config: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.6-luna" } },
};
const validateWizardResult = Compile(WizardNextResultSchema);

function makeContext() {
  const wizardSessions = new Map<string, WizardSession>();
  return {
    wizardSessions,
    context: {
      wizardSessions,
      findRunningWizard: () => undefined,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
    } as unknown as GatewayRequestContext,
  };
}

function makeRespond() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

function systemAgentHandler(method: keyof typeof systemAgentHandlers) {
  return expectDefined(systemAgentHandlers[method], `systemAgentHandlers["${method}"] invariant`);
}

async function callWizardNext(
  context: GatewayRequestContext,
  params: WizardNextParams,
): Promise<WizardNextResult> {
  const { calls, respond } = makeRespond();
  await expectDefined(
    wizardHandlers["wizard.next"],
    "wizard.next handler",
  )({
    params,
    respond,
    context,
  } as never);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  const payload = calls[0]?.payload;
  if (!validateWizardResult.Check(payload)) {
    throw new Error("wizard.next returned an invalid result");
  }
  return payload;
}

describe("openclaw.setup provider resolution", () => {
  beforeEach(() => {
    setupSharedMocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "setup-resolution-config",
      sourceConfig: config,
      config,
      issues: [],
    });
    setupSharedMocks.writeWizardConfigFile.mockImplementation(
      async (writtenConfig) => writtenConfig,
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
    resetCommandQueueStateForTest();
  });

  it.each([
    [
      "openclaw.setup.activate.start",
      { sessionId: "retained-session", kind: "codex-cli", modelRef: "example/model" },
    ],
    ["openclaw.setup.auth.start", { sessionId: "retained-session", authChoice: "github-copilot" }],
    ["openclaw.setup.prepare.start", { sessionId: "retained-session", authChoice: "ollama" }],
  ] as const)("does not replace a retained wizard session through %s", async (method, params) => {
    const { wizardSessions, context } = makeContext();
    const retained = new WizardSession(async () => {});
    wizardSessions.set(params.sessionId, retained);
    await retained.whenSettled();
    const { calls, respond } = makeRespond();

    await systemAgentHandler(method)({ params, respond, context } as never);

    expect(calls).toEqual([
      {
        ok: false,
        payload: undefined,
        error: expect.objectContaining({ message: "wizard session already exists" }),
      },
    ]);
    expect(wizardSessions.get(params.sessionId)).toBe(retained);
    expect(setupInferenceMocks.activateSetupInference).not.toHaveBeenCalled();
    expect(providerAuthChoiceMocks.prepareAuthChoiceLoadedPluginProvider).not.toHaveBeenCalled();
  });

  it.each([true, false, "true", "cancel"])(
    "keeps runtime capability consent server-owned through activation (%s)",
    async (answer) => {
      const { wizardSessions, context } = makeContext();
      const sessionId = "runtime-consent";
      const commit = vi.fn();
      const review = buildPluginCapabilityConsentReview({
        pluginId: "test-runtime",
        manifest: { name: "Test runtime" },
        config: {},
        record: { source: "npm", spec: "@example/runtime@1.0.0", integrity: "sha512-fixture" },
      });
      setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
        const acknowledgment = await createPluginCapabilityConsentPrompter(params.prompter, () =>
          params.signal.throwIfAborted(),
        )(review);
        if (!acknowledgment) {
          return { ok: false, status: "unavailable", error: "Capabilities were not accepted." };
        }
        expect(acknowledgment.reviewToken).toBe(review.reviewToken);
        commit();
        return {
          ok: true,
          modelRef: "example/model",
          latencyMs: 1,
          lines: [],
          gatewayRestartRequired: true,
        };
      });
      const { calls, respond } = makeRespond();
      await systemAgentHandler("openclaw.setup.activate.start")({
        params: { sessionId, kind: "codex-cli", modelRef: "example/model" },
        respond,
        context,
      } as never);
      expect(calls[0]).toMatchObject({
        ok: true,
        payload: { sessionId, done: false, status: "running" },
      });
      const session = expectDefined(wizardSessions.get(sessionId), "activation wizard session");
      const note = await callWizardNext(context, { sessionId });
      expect(note.step).toMatchObject({ type: "note", title: "Plugin capabilities" });
      expect(JSON.stringify(note)).not.toContain(review.reviewToken);
      const confirmation = await callWizardNext(context, {
        sessionId,
        answer: { stepId: expectDefined(note.step, "capability review").id },
      });
      expect(confirmation.step).toMatchObject({ type: "confirm", initialValue: false });
      expect(commit).not.toHaveBeenCalled();
      if (answer === "cancel") {
        await expectDefined(
          wizardHandlers["wizard.cancel"],
          "wizard cancel",
        )({
          params: { sessionId },
          respond: () => undefined,
          context,
        } as never);
        await whenAdmittedWizardSessionSettled(session);
      } else {
        const done = await callWizardNext(context, {
          sessionId,
          answer: {
            stepId: expectDefined(confirmation.step, "capability decision").id,
            value: answer,
          },
        });
        expect(done).toMatchObject(
          answer === true
            ? {
                done: true,
                status: "done",
                modelActivation: { modelRef: "example/model", gatewayRestartRequired: true },
              }
            : { done: true, status: "cancelled" },
        );
        if (answer !== true) {
          expect(done).not.toHaveProperty("modelActivation");
        }
      }
      expect(commit).toHaveBeenCalledTimes(answer === true ? 1 : 0);
      expect(wizardSessions.has(sessionId)).toBe(false);
    },
  );

  it("locks cancellation before an accepted runtime install can start", async () => {
    const { wizardSessions, context } = makeContext();
    const sessionId = "runtime-install-lock";
    let reportLocked = () => {};
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    let releaseInstall = () => {};
    const installReleased = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
      const accepted = await params.prompter.confirm({
        message: "Install the reviewed runtime?",
        initialValue: false,
      });
      expect(accepted).toBe(true);
      await params.beforePersistentEffect?.();
      reportLocked();
      await installReleased;
      return { ok: true, modelRef: "example/model", latencyMs: 1, lines: [] };
    });
    await systemAgentHandler("openclaw.setup.activate.start")({
      params: { sessionId, kind: "codex-cli", modelRef: "example/model" },
      respond: () => undefined,
      context,
    } as never);
    const confirmation = await callWizardNext(context, { sessionId });
    const terminal = callWizardNext(context, {
      sessionId,
      answer: {
        stepId: expectDefined(confirmation.step, "runtime install confirmation").id,
        value: true,
      },
    });
    await locked;

    const { calls, respond } = makeRespond();
    await expectDefined(
      wizardHandlers["wizard.cancel"],
      "wizard cancel",
    )({
      params: { sessionId },
      respond,
      context,
    } as never);
    expect(calls).toEqual([
      { ok: true, payload: { status: "running", error: undefined }, error: undefined },
    ]);
    expect(wizardSessions.has(sessionId)).toBe(true);

    releaseInstall();
    await expect(terminal).resolves.toMatchObject({ done: true, status: "done" });
    expect(wizardSessions.has(sessionId)).toBe(false);
  });

  it.each([
    "cancel at credentials",
    "expire during installation",
    "expire at credentials",
    "expire before provider note",
    "expire before final commit",
    "cancel after final commit",
    "expire after final commit",
  ])("retains install ownership but permits %s", async (action) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { wizardSessions, context } = makeContext();
    const sessionId = "provider-install-then-credentials";
    const installStarted = createDeferredCore();
    const finishInstall = createDeferredCore();
    const persistCredentials = vi.fn();
    const promoteModel = vi.fn();
    const finalCommit = action.endsWith("after final commit");
    const expiresDuringInstall = [
      "expire during installation",
      "expire before provider note",
      "expire before final commit",
    ].includes(action);
    let installed = false;
    let cleaningUp = false;
    let session: WizardSession | undefined;
    let statusAtCheckpoint: string | undefined;
    let abortedAtCheckpoint: boolean | undefined;
    let offeredStepType: string | undefined;
    let submittedBeforeCleanup = false;
    let cancelResult: unknown;
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(
      async (params: ActivateSetupInferenceParams) => {
        const prompter = expectDefined(params.prompter, "provider auth prompter");
        const accepted = await prompter.confirm({
          message: "Install the reviewed provider?",
          initialValue: false,
        });
        expect(accepted).toBe(true);
        await params.beforePersistentEffect?.();
        const progress = prompter.progress("Installing reviewed provider");
        installStarted.resolve();
        await finishInstall.promise;
        if (cleaningUp) {
          throw new Error("fixture cleanup");
        }
        params.signal?.throwIfAborted();
        installed = true;
        progress.stop();
        if (action === "expire before provider note") {
          await prompter.note("Provider installed. Continue to connect your account.");
          if (cleaningUp) {
            throw new Error("fixture cleanup");
          }
        }
        if (action === "expire before final commit") {
          params.onCommitStarted?.(config);
          promoteModel();
          return { ok: true, modelRef: "fixture/demo-model", latencyMs: 1, lines: [] };
        }
        if (finalCommit) {
          params.onCommitStarted?.(config);
        }
        await prompter.text({ message: "Provider API key", sensitive: true });
        params.signal?.throwIfAborted();
        persistCredentials();
        return { ok: true, modelRef: "fixture/demo-model", latencyMs: 1, lines: [] };
      },
    );
    const cancel = async () => {
      const { calls, respond } = makeRespond();
      await expectDefined(
        wizardHandlers["wizard.cancel"],
        "wizard cancel",
      )({
        params: { sessionId },
        respond,
        context,
      } as never);
      return calls[0]?.payload;
    };
    try {
      await systemAgentHandler("openclaw.setup.auth.start")({
        params: { sessionId, authChoice: "fixture-provider" },
        respond: () => undefined,
        context,
      } as never);
      session = expectDefined(wizardSessions.get(sessionId), "provider auth wizard");
      const confirmation = await callWizardNext(context, { sessionId });
      await session.answer(expectDefined(confirmation.step, "install confirmation").id, true);
      await installStarted.promise;
      const progress = await callWizardNext(context, { sessionId });
      expect(progress.step?.type).toBe("progress");
      // A legacy client's progress acknowledgement cannot release the artifact fence.
      await session.answer(expectDefined(progress.step, "install progress").id, undefined);
      expect(await cancel()).toMatchObject({ status: "running" });
      expect(session.signal.aborted).toBe(false);
      if (expiresDuringInstall) {
        await vi.advanceTimersByTimeAsync(25 * 60 * 1_000);
        expect(session.getStatus()).toBe("running");
        expect(session.signal.aborted).toBe(false);
      }
      const next = callWizardNext(context, { sessionId });
      finishInstall.resolve();
      const checkpoint = await next;
      offeredStepType = checkpoint.step?.type;
      if (action.startsWith("cancel")) {
        cancelResult = await cancel();
      } else if (!expiresDuringInstall) {
        await vi.advanceTimersByTimeAsync(25 * 60 * 1_000);
      }
      statusAtCheckpoint = session.getStatus();
      abortedAtCheckpoint = session.signal.aborted;
      submittedBeforeCleanup = persistCredentials.mock.calls.length !== 0;
    } finally {
      cleaningUp = true;
      finishInstall.resolve();
      // The pre-fix implementation refuses cancellation even at the credential prompt.
      // Answer it only to retire the fixture; record the tested outcome before cleanup.
      const pending = session?.getCurrentStep();
      if (pending?.type === "text" || pending?.type === "note") {
        await session?.answer(pending.id, "fixture-cleanup");
      } else {
        session?.cancel();
      }
      if (session) {
        await whenAdmittedWizardSessionSettled(session);
      }
      vi.useRealTimers();
    }
    expect(installed).toBe(true);
    expect(submittedBeforeCleanup).toBe(false);
    expect(setupSharedMocks.writeWizardConfigFile).not.toHaveBeenCalled();
    expect(offeredStepType).toBe(expiresDuringInstall ? undefined : "text");
    expect(promoteModel).not.toHaveBeenCalled();
    expect(statusAtCheckpoint).toBe(finalCommit ? "running" : "cancelled");
    expect(abortedAtCheckpoint).toBe(!finalCommit);
    if (action.startsWith("cancel")) {
      expect(cancelResult).toMatchObject({ status: finalCommit ? "running" : "cancelled" });
    }
    if (!finalCommit) {
      expect(persistCredentials).not.toHaveBeenCalled();
      expect(await session?.next()).not.toHaveProperty("modelActivation");
    }
  });

  it("permits cancellation during verification after an install without another prompt", async () => {
    const { wizardSessions, context } = makeContext();
    const sessionId = "installed-provider-verification";
    const probeStarted = createDeferredCore();
    const finishProbe = createDeferredCore();
    const promoteModel = vi.fn();
    let installed = false;
    let cancelResult: unknown;
    let abortedAfterCancel = false;
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(
      async (params: ActivateSetupInferenceParams) => {
        await params.beforePersistentEffect?.();
        installed = true;
        params.onPreparationComplete?.();
        expectDefined(params.prompter, "verification prompter").progress(
          "Testing selected provider",
        );
        probeStarted.resolve();
        await finishProbe.promise;
        params.signal?.throwIfAborted();
        params.onCommitStarted?.(config);
        promoteModel();
        return { ok: true, modelRef: "fixture/demo-model", latencyMs: 1, lines: [] };
      },
    );
    await systemAgentHandler("openclaw.setup.activate.start")({
      params: { sessionId, kind: "codex-cli", modelRef: "fixture/demo-model" },
      respond: () => undefined,
      context,
    } as never);
    const session = expectDefined(wizardSessions.get(sessionId), "verification wizard");
    try {
      const progress = await callWizardNext(context, { sessionId });
      expect(progress.step?.type).toBe("progress");
      await probeStarted.promise;
      const { calls, respond } = makeRespond();
      await expectDefined(
        wizardHandlers["wizard.cancel"],
        "wizard cancel",
      )({
        params: { sessionId },
        respond,
        context,
      } as never);
      cancelResult = calls[0]?.payload;
      abortedAfterCancel = session.signal.aborted;
      expect(wizardSessions.has(sessionId)).toBe(true);
    } finally {
      finishProbe.resolve();
      await whenAdmittedWizardSessionSettled(session);
    }
    expect(installed).toBe(true);
    expect(cancelResult).toMatchObject({ status: "cancelled" });
    expect(abortedAfterCancel).toBe(true);
    expect(promoteModel).not.toHaveBeenCalled();
    expect(await session.next()).not.toHaveProperty("modelActivation");
    expect(wizardSessions.has(sessionId)).toBe(false);
  });

  it.each([
    ["missing", null],
    ["retryable", { config, retrySelection: true, authProfiles: [], persistAuthProfiles: vi.fn() }],
  ])("returns actionable doctor guidance when provider setup is %s", async (_, result) => {
    providerAuthChoiceMocks.prepareAuthChoiceLoadedPluginProvider.mockResolvedValueOnce(result);
    const { wizardSessions, context } = makeContext();
    const handler = expectDefined(
      systemAgentHandlers["openclaw.setup.prepare.start"],
      "openclaw.setup.prepare.start handler",
    );

    await handler({
      params: { sessionId: "prepare-resolution-error", authChoice: "ollama" },
      respond: () => undefined,
      context,
    } as never);

    const session = expectDefined(
      wizardSessions.get("prepare-resolution-error"),
      "prepare wizard session",
    );
    await expect(session.next()).resolves.toMatchObject({
      done: true,
      status: "error",
      error:
        'Error: Provider setup resolution failed for "ollama". Run `openclaw doctor --fix`, restart the Gateway, and try again.',
    });
    await whenAdmittedWizardSessionSettled(session);
    expect(setupSharedMocks.writeWizardConfigFile).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "returns verified provider auth through wizard transport (restart %s)",
    async (restart) => {
      const { wizardSessions, context } = makeContext();
      setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
        await params.prompter.note("Open the browser and enter ABCD", "Pair GitHub");
        return {
          ok: true,
          modelRef: "github-copilot/test",
          latencyMs: 10,
          lines: ["ready"],
          ...(restart ? { gatewayRestartRequired: true } : {}),
        };
      });
      const { calls, respond } = makeRespond();

      await systemAgentHandler("openclaw.setup.auth.start")({
        params: { sessionId: "auth-session-1", agentId: "research", authChoice: "github-copilot" },
        respond,
        context,
      } as never);

      expect(calls[0]).toMatchObject({
        ok: true,
        payload: { sessionId: "auth-session-1", done: false, status: "running" },
      });
      expect(calls[0]?.payload).not.toHaveProperty("modelActivation");
      const session = expectDefined(wizardSessions.get("auth-session-1"), "auth wizard session");
      const first = await callWizardNext(context, { sessionId: "auth-session-1" });
      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "provider-auth", authChoice: "github-copilot" }),
      );
      expect(setupInferenceMocks.activateSetupInference.mock.calls[0]?.[0].agentId).toBe(
        "research",
      );
      expect(setupInferenceMocks.activateSetupInference.mock.calls[0]?.[0].signal).toBe(
        session.signal,
      );
      expect(first).toMatchObject({
        done: false,
        status: "running",
        step: { type: "note", title: "Pair GitHub", message: "Open the browser and enter ABCD" },
      });
      expect(first).not.toHaveProperty("modelActivation");
      const done = await callWizardNext(context, {
        sessionId: "auth-session-1",
        answer: { stepId: expectDefined(first.step, "auth wizard step").id, value: null },
      });
      expect(done).toEqual({
        done: true,
        status: "done",
        modelActivation: {
          modelRef: "github-copilot/test",
          ...(restart ? { gatewayRestartRequired: true } : {}),
        },
      });
      expect(wizardSessions.has("auth-session-1")).toBe(false);
    },
  );
  it.each([
    "auth",
    "rate_limit",
    "billing",
    "timeout",
    "format",
    "unavailable",
    "unknown",
  ] as const)(
    "publishes a finalized %s probe rejection after capability consent",
    async (status) => {
      const { wizardSessions, context } = makeContext();
      const sessionId = "rejected-probe";
      const finalizationStarted = createDeferredCore();
      const finishFinalization = createDeferredCore();
      const review = buildPluginCapabilityConsentReview({
        pluginId: "test-runtime",
        manifest: { name: "Test runtime" },
        config: {},
        record: { source: "npm", spec: "@example/runtime@1.0.0", integrity: "sha512-fixture" },
      });
      setupInferenceMocks.activateSetupInference.mockImplementationOnce(
        async (params: ActivateSetupInferenceParams) => {
          const prompter = expectDefined(params.prompter, "activation prompter");
          const acknowledgment = await createPluginCapabilityConsentPrompter(prompter)(review);
          expect(acknowledgment).toBeDefined();
          await params.beforePersistentEffect?.();
          const progress = prompter.progress("Testing your AI connection…");
          try {
            return {
              ok: false,
              status,
              error: "Probe rejected [redacted]",
              disposition: "rejected-before-promotion",
            };
          } finally {
            finalizationStarted.resolve();
            await finishFinalization.promise;
            progress.stop();
          }
        },
      );
      const { calls, respond } = makeRespond();
      await systemAgentHandler("openclaw.setup.activate.start")({
        params: { sessionId, kind: "codex-cli", modelRef: "example/model" },
        respond,
        context,
      } as never);
      expect(calls[0]).toMatchObject({
        ok: true,
        payload: { sessionId, done: false, status: "running" },
      });
      const session = expectDefined(wizardSessions.get(sessionId), "activation wizard session");
      try {
        const reviewStep = await callWizardNext(context, { sessionId });
        expect(reviewStep.step).toMatchObject({ type: "note", title: "Plugin capabilities" });
        const confirmation = await callWizardNext(context, {
          sessionId,
          answer: { stepId: expectDefined(reviewStep.step, "capability review").id },
        });
        expect(confirmation.step).toMatchObject({ type: "confirm" });
        const progress = await callWizardNext(context, {
          sessionId,
          answer: {
            stepId: expectDefined(confirmation.step, "capability consent").id,
            value: true,
          },
        });
        await finalizationStarted.promise;
        expect(progress).toMatchObject({
          done: false,
          status: "running",
          step: { type: "progress" },
        });
        for (const frame of [calls[0]?.payload, reviewStep, confirmation, progress]) {
          expect(frame).not.toHaveProperty("activationRejection");
          expect(frame).not.toHaveProperty("modelActivation");
        }
        expect(session.isSettled()).toBe(false);
        const published = vi.fn();
        const terminal = callWizardNext(context, { sessionId });
        const observed = terminal.then(published, published);
        try {
          await Promise.resolve();
          expect(published).not.toHaveBeenCalled();
          expect(wizardSessions.has(sessionId)).toBe(true);
        } finally {
          finishFinalization.resolve();
          await observed;
        }
        const done = await terminal;
        expect(done).toEqual({
          done: true,
          status: "error",
          error: "Error: Probe rejected [redacted]",
          activationRejection: { disposition: "rejected-before-promotion", status },
        });
        expect(done).not.toHaveProperty("modelActivation");
        expect(session.isSettled()).toBe(true);
        expect(wizardSessions.has(sessionId)).toBe(false);
      } finally {
        finishFinalization.resolve();
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  );

  it.each([false, true])(
    "preserves the host shutdown outcome across activation (committed=%s)",
    async (committed) => {
      const { wizardSessions, context } = makeContext();
      const sessionId = "activation-during-host-shutdown";
      const activationStarted = createDeferredCore();
      const finishActivation = createDeferredCore();
      const shutdownMessage = "Gateway is shutting down; restart it before continuing setup.";
      setupInferenceMocks.activateSetupInference.mockImplementationOnce(
        async (params: ActivateSetupInferenceParams) => {
          if (committed) {
            params.onCommitStarted?.(config);
          }
          activationStarted.resolve();
          await finishActivation.promise;
          if (params.signal?.aborted) {
            return { ok: false, status: "unavailable", error: "Provider login was cancelled." };
          }
          return { ok: true, modelRef: "fixture/demo-model", latencyMs: 1, lines: [] };
        },
      );
      await systemAgentHandler("openclaw.setup.activate.start")({
        params: { sessionId, kind: "codex-cli", modelRef: "fixture/demo-model" },
        respond: () => undefined,
        context,
      } as never);
      const session = expectDefined(wizardSessions.get(sessionId), "activation wizard");
      try {
        await activationStarted.promise;
        session.close(new Error(shutdownMessage));
        expect(session.signal.aborted).toBe(!committed);
        finishActivation.resolve();
        await whenAdmittedWizardSessionSettled(session);
        const done = await callWizardNext(context, { sessionId });
        if (committed) {
          expect(done).toMatchObject({
            done: true,
            status: "done",
            modelActivation: { modelRef: "fixture/demo-model" },
          });
        } else {
          expect(done).toMatchObject({
            done: true,
            status: "error",
            error: `Error: ${shutdownMessage}`,
          });
          expect(done).not.toHaveProperty("modelActivation");
        }
        expect(wizardSessions.has(sessionId)).toBe(false);
      } finally {
        finishActivation.resolve();
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  );

  it("returns finalized rejection instead of buffered progress on the first wizard.next", async () => {
    const { wizardSessions, context } = makeContext();
    const sessionId = "buffered-probe-rejection";
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(
      async (params: ActivateSetupInferenceParams) => {
        const progress = expectDefined(params.prompter, "activation prompter").progress(
          "Testing your AI connection…",
        );
        progress.update("Finishing AI setup…");
        progress.stop();
        return {
          ok: false,
          status: "auth",
          error: "Provider rejected sign-in",
          disposition: "rejected-before-promotion",
        };
      },
    );
    await systemAgentHandler("openclaw.setup.activate.start")({
      params: { sessionId, kind: "codex-cli", modelRef: "example/model" },
      respond: () => undefined,
      context,
    } as never);
    const session = expectDefined(wizardSessions.get(sessionId), "activation wizard session");
    await whenAdmittedWizardSessionSettled(session);

    const done = await callWizardNext(context, { sessionId });
    expect(done).toEqual({
      done: true,
      status: "error",
      error: "Error: Provider rejected sign-in",
      activationRejection: { disposition: "rejected-before-promotion", status: "auth" },
    });
    expect(done).not.toHaveProperty("step");
    expect(done).not.toHaveProperty("modelActivation");
    expect(wizardSessions.has(sessionId)).toBe(false);
  });

  it.each([
    "failed",
    "rejected",
    "persistence-unknown",
    "thrown",
    "retention-indeterminate",
    "application-error",
    "cancelled",
  ] as const)(
    "reports only proven rejection without verified activation for %s provider auth",
    async (outcome) => {
      const { wizardSessions, context } = makeContext();
      const sessionId = "unverified-auth";
      setupInferenceMocks.activateSetupInference.mockImplementationOnce(
        async (params: ActivateSetupInferenceParams) => {
          await expectDefined(params.prompter, "auth prompter").confirm({
            message: "Continue sign-in?",
          });
          if (outcome === "thrown") {
            throw new Error("401 Provider rejected sign-in");
          }
          if (outcome === "retention-indeterminate") {
            throw new SetupInferenceActivationIndeterminateError("Could not retain Codex safely");
          }
          if (outcome === "application-error") {
            params.onCommitStarted?.(config);
            const application = createRuntimeConfigWriteApplication();
            expectDefined(application.claim(), "application claim").settle("failed");
            params.onRuntimeApplication?.(application);
            return { ok: true, modelRef: "example/model", latencyMs: 1, lines: [] };
          }
          return {
            ok: false,
            status: outcome === "persistence-unknown" ? "unknown" : "auth",
            error: "Provider rejected sign-in",
            ...(outcome === "rejected" ? { disposition: "rejected-before-promotion" } : {}),
          };
        },
      );
      await systemAgentHandler("openclaw.setup.auth.start")({
        params: { sessionId, authChoice: "github-copilot" },
        respond: () => undefined,
        context,
      } as never);
      const session = expectDefined(wizardSessions.get(sessionId), "auth wizard session");
      const first = await callWizardNext(context, { sessionId });
      if (outcome === "cancelled") {
        const { calls, respond } = makeRespond();
        await expectDefined(
          wizardHandlers["wizard.cancel"],
          "wizard.cancel handler",
        )({
          params: { sessionId },
          respond,
          context,
        } as never);
        expect(calls[0]).toEqual({
          ok: true,
          payload: { status: "cancelled", error: "cancelled" },
          error: undefined,
        });
        await whenAdmittedWizardSessionSettled(session);
        const cancelled = await session.next();
        expect(cancelled).not.toHaveProperty("activationRejection");
        expect(cancelled).not.toHaveProperty("modelActivation");
      } else {
        const done = await callWizardNext(context, {
          sessionId,
          answer: { stepId: expectDefined(first.step, "auth confirmation step").id, value: true },
        });
        expect(done).toEqual({
          done: true,
          status: "error",
          error:
            outcome === "application-error"
              ? expect.stringContaining("AI access was saved, but the Gateway could not apply it")
              : outcome === "retention-indeterminate"
                ? "SetupInferenceActivationIndeterminateError: Could not retain Codex safely"
                : outcome === "thrown"
                  ? "Error: 401 Provider rejected sign-in"
                  : "Error: Provider rejected sign-in",
          ...(outcome === "rejected"
            ? { activationRejection: { disposition: "rejected-before-promotion", status: "auth" } }
            : {}),
        });
        expect(done).not.toHaveProperty("modelActivation");
        if (outcome !== "rejected") {
          expect(done).not.toHaveProperty("activationRejection");
        }
        expect(session.isSettled()).toBe(true);
      }
      expect(wizardSessions.has(sessionId)).toBe(false);
    },
  );
});
