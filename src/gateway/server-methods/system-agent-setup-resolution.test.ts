// OpenClaw setup resolution tests cover terminal provider guidance.
import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WizardNextParams,
  WizardNextResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { WizardNextResultSchema } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildPluginCapabilityConsentReview } from "../../plugins/capability-summary.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createPluginCapabilityConsentPrompter } from "../../wizard/plugin-capability-consent.js";
import { WizardSession } from "../../wizard/session.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const setupInferenceMocks = vi.hoisted(() => ({ activateSetupInference: vi.fn() }));
const providerAuthChoiceMocks = vi.hoisted(() => ({
  applyAuthChoiceLoadedPluginProvider: vi.fn(),
}));
const setupSharedMocks = vi.hoisted(() => ({
  readSetupConfigFileSnapshot: vi.fn(),
  writeWizardConfigFile: vi.fn(),
}));
const modelsAuthLoginMocks = vi.hoisted(() => ({
  runModelsAuthLoginFlowCore: vi.fn(),
  resolveManifestProviderAuthChoice: vi.fn(),
  resolveManifestProviderAuthChoices: vi.fn(() => []),
  refreshModelAuthStateAfterMutation: vi.fn(async () => undefined),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
}));
vi.mock("../../plugins/provider-auth-choice.js", () => ({
  applyAuthChoiceLoadedPluginProvider: providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider,
}));
vi.mock("../../wizard/setup.shared.js", () => ({
  readSetupConfigFileSnapshot: setupSharedMocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: setupSharedMocks.writeWizardConfigFile,
}));
vi.mock("../../commands/models/auth.js", () => ({
  runModelsAuthLoginFlowCore: modelsAuthLoginMocks.runModelsAuthLoginFlowCore,
}));
vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice: modelsAuthLoginMocks.resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices: modelsAuthLoginMocks.resolveManifestProviderAuthChoices,
}));
vi.mock("./models-auth-status.js", () => ({
  refreshModelAuthStateAfterMutation: modelsAuthLoginMocks.refreshModelAuthStateAfterMutation,
}));

const config: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.6-luna" } },
};
const validateWizardResult = Compile(WizardNextResultSchema);

function makeContext(runtimeConfig: OpenClawConfig = config) {
  const tracker = createWizardSessionTracker();
  return {
    wizardSessions: tracker.wizardSessions,
    context: {
      ...tracker,
      getRuntimeConfig: () => runtimeConfig,
    } as unknown as GatewayRequestContext,
  };
}

function trackedWizardSession(
  wizardSessions: ReturnType<typeof createWizardSessionTracker>["wizardSessions"],
  sessionId: string,
): WizardSession | undefined {
  return wizardSessions.get(sessionId)?.session;
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

function startedWizardSessionId(calls: ReturnType<typeof makeRespond>["calls"]): string {
  const payload = calls[0]?.payload;
  if (!payload || typeof payload !== "object" || !("sessionId" in payload)) {
    throw new Error("Expected wizard start response");
  }
  return expectDefined(
    typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    "wizard session id",
  );
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
    modelsAuthLoginMocks.resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "github-copilot",
      providerId: "github-copilot",
      methodId: "oauth",
      choiceId: "github-copilot",
      choiceLabel: "GitHub Copilot",
      appGuidedAuth: "device-code",
    });
    const { wizardSessions, context } = makeContext();
    const retained = new WizardSession(async () => {});
    context.trackWizardSession(retained, undefined, params.sessionId);
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
    expect(trackedWizardSession(wizardSessions, params.sessionId)).toBe(retained);
    expect(setupInferenceMocks.activateSetupInference).not.toHaveBeenCalled();
    expect(providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider).not.toHaveBeenCalled();
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
      const session = expectDefined(
        trackedWizardSession(wizardSessions, sessionId),
        "activation wizard session",
      );
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
    ["missing", null],
    ["retryable", { config, retrySelection: true }],
  ])("returns actionable doctor guidance when provider setup is %s", async (_, result) => {
    providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValueOnce(result);
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
      trackedWizardSession(wizardSessions, "prepare-resolution-error"),
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
  it("persists provider sign-in and selects its default without an inference request", async () => {
    const runtimeConfig: OpenClawConfig = {};
    const { wizardSessions, context } = makeContext(runtimeConfig);
    modelsAuthLoginMocks.resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "xai",
      providerId: "xai",
      methodId: "oauth",
      choiceId: "xai-oauth",
      choiceLabel: "xAI OAuth",
      appGuidedAuth: "device-code",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    modelsAuthLoginMocks.runModelsAuthLoginFlowCore.mockImplementationOnce(async (options) => {
      await options.beforePersistentEffect?.();
      return {
        providerId: "xai",
        methodId: "oauth",
        defaultModel: "xai/grok-4.6",
        modelAccess: "enabled",
        profiles: [{ profileId: "xai:owner", provider: "xai", mode: "oauth" }],
      };
    });
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.auth.start")({
      params: { sessionId: "auth-session-1", agentId: "research", authChoice: "xai-oauth" },
      respond,
      context,
    } as never);

    const done = await callWizardNext(context, { sessionId: "auth-session-1" });

    expect(done).toEqual({
      done: true,
      status: "done",
      modelActivation: { modelRef: "xai/grok-4.6" },
    });
    expect(modelsAuthLoginMocks.runModelsAuthLoginFlowCore).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialOnly: true,
        setDefault: true,
        provider: "xai",
        agent: "research",
      }),
    );
    expect(setupInferenceMocks.activateSetupInference).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wizardSessions.has("auth-session-1")).toBe(false);
    fetchMock.mockRestore();
    expect(calls[0]).toMatchObject({ ok: true });
  });
  it("runs the selected provider method in a shared wizard session and commits its config", async () => {
    const preparedConfig: OpenClawConfig = {
      ...config,
      models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
    };
    providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider.mockImplementationOnce(
      async (params) => {
        await params.prompter.note("Model ready", "Ollama");
        await params.beforePersistentEffect();
        return { config: preparedConfig, agentModelOverride: "ollama/qwen3:0.6b" };
      },
    );
    const { wizardSessions, context } = makeContext();
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.prepare.start")({
      params: {
        sessionId: "prepare-session-1",
        agentId: "research",
        authChoice: "ollama",
        workspace: "/tmp/models-workspace",
      },
      respond,
      context,
    } as never);

    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { sessionId: "prepare-session-1", done: false, status: "running" },
    });
    const session = expectDefined(
      trackedWizardSession(wizardSessions, "prepare-session-1"),
      "prepare wizard session",
    );
    const note = await callWizardNext(context, { sessionId: "prepare-session-1" });
    expect(note).toMatchObject({
      done: false,
      step: { type: "note", title: "Ollama", message: "Model ready" },
    });
    expect(providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "ollama",
        agentId: "research",
        config,
        workspaceDir: "/tmp/models-workspace",
        setDefaultModel: false,
        preserveExistingDefaultModel: true,
        signal: session.signal,
        isRemote: true,
      }),
    );
    const done = await callWizardNext(context, {
      sessionId: "prepare-session-1",
      answer: { stepId: expectDefined(note.step, "prepare wizard step").id, value: null },
    });
    expect(done).toEqual({
      done: true,
      status: "done",
      preparedModelRef: "ollama/qwen3:0.6b",
    });
    expect(setupSharedMocks.writeWizardConfigFile).toHaveBeenCalledWith(preparedConfig, {
      allowConfigSizeDrop: false,
      baseSnapshot: expect.objectContaining({ hash: "setup-resolution-config" }),
      baseHash: "setup-resolution-config",
    });
  });
});

describe("openclaw.setup.auth.start", () => {
  beforeEach(() => {
    modelsAuthLoginMocks.resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "xai",
      providerId: "xai",
      methodId: "oauth",
      choiceId: "xai-oauth",
      choiceLabel: "xAI OAuth",
      appGuidedAuth: "device-code",
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    resetCommandQueueStateForTest();
  });

  it("runs credential-only provider auth through the shared wizard", async () => {
    modelsAuthLoginMocks.runModelsAuthLoginFlowCore.mockImplementationOnce(async (options) => {
      await options.prompter.deviceCode?.({
        title: "xAI OAuth",
        code: "XAI-CODE",
        message: "URL: https://accounts.x.ai/device",
      });
      await options.beforePersistentEffect?.();
      await options.refreshAuthState?.("research");
      return {
        providerId: "xai",
        methodId: "oauth",
        defaultModel: "xai/grok-4",
        profiles: [{ profileId: "xai:owner", provider: "xai", mode: "oauth" }],
      };
    });
    const { wizardSessions, context } = makeContext();
    const { calls, respond } = makeRespond();

    await expectDefined(
      systemAgentHandlers["openclaw.setup.auth.start"],
      "openclaw.setup.auth.start handler",
    )({
      params: { sessionId: "auth-session-2", agentId: "research", authChoice: "xai-oauth" },
      respond,
      context,
    } as never);

    expect(calls[0]).toMatchObject({ ok: true, payload: { done: false, status: "running" } });
    const sessionId = startedWizardSessionId(calls);
    const session = expectDefined(
      trackedWizardSession(wizardSessions, sessionId),
      "provider login session",
    );
    const deviceCode = await callWizardNext(context, { sessionId });
    expect(deviceCode).toMatchObject({
      done: false,
      step: { type: "note", title: "xAI OAuth", deviceCode: { code: "XAI-CODE" } },
    });
    const done = await callWizardNext(context, {
      sessionId,
      answer: { stepId: expectDefined(deviceCode.step, "device code step").id, value: null },
    });

    expect(done).toEqual({
      done: true,
      status: "done",
      modelActivation: { modelRef: "xai/grok-4" },
    });
    const loginOptions = modelsAuthLoginMocks.runModelsAuthLoginFlowCore.mock.calls[0]?.[0];
    expect(loginOptions).toMatchObject({
      provider: "xai",
      method: "oauth",
      ownerPluginId: "xai",
      credentialOnly: true,
      agent: "research",
    });
    expect(loginOptions).toHaveProperty("setDefault", false);
    expect(modelsAuthLoginMocks.refreshModelAuthStateAfterMutation).toHaveBeenCalledWith(
      context,
      "login",
      "research",
    );
    expect(session.cancel()).toBe(false);
  });

  it("cancels provider login when its request owner disconnects before persistence", async () => {
    let persisted = false;
    modelsAuthLoginMocks.runModelsAuthLoginFlowCore.mockImplementationOnce(async (options) => {
      await options.prompter.deviceCode?.({
        title: "xAI OAuth",
        code: "XAI-CODE",
      });
      options.signal?.throwIfAborted();
      persisted = true;
      return {
        providerId: "xai",
        methodId: "oauth",
        modelAccess: "enabled",
        profiles: [{ profileId: "xai:owner", provider: "xai", mode: "oauth" }],
      };
    });
    const { wizardSessions, context } = makeContext();
    const { calls, respond } = makeRespond();
    const requestOwner = new AbortController();

    const running = expectDefined(
      systemAgentHandlers["openclaw.setup.auth.start"],
      "openclaw.setup.auth.start handler",
    )({
      params: { sessionId: "auth-session-3", authChoice: "xai-oauth" },
      respond,
      context,
      signal: requestOwner.signal,
    } as never);
    await vi.waitFor(() => expect(calls[0]?.ok).toBe(true));
    const sessionId = startedWizardSessionId(calls);
    const session = expectDefined(
      trackedWizardSession(wizardSessions, sessionId),
      "provider login session",
    );
    await callWizardNext(context, { sessionId });

    requestOwner.abort();

    await vi.waitFor(() => expect(session.getStatus()).toBe("cancelled"));
    await running;
    expect(persisted).toBe(false);
    expect(wizardSessions.has(sessionId)).toBe(false);
  });

  it("finishes provider login when its request owner disconnects after persistence starts", async () => {
    const persistenceStarted = createDeferredCore();
    const releasePersistence = createDeferredCore();
    let persisted = false;
    modelsAuthLoginMocks.runModelsAuthLoginFlowCore.mockImplementationOnce(async (options) => {
      await options.prompter.deviceCode?.({ title: "xAI OAuth", code: "XAI-CODE" });
      await options.beforePersistentEffect?.();
      persistenceStarted.resolve();
      await releasePersistence.promise;
      persisted = true;
      return {
        providerId: "xai",
        methodId: "oauth",
        modelAccess: "enabled",
        profiles: [{ profileId: "xai:owner", provider: "xai", mode: "oauth" }],
      };
    });
    const { wizardSessions, context } = makeContext();
    const { calls, respond } = makeRespond();
    const requestOwner = new AbortController();

    const running = expectDefined(
      systemAgentHandlers["openclaw.setup.auth.start"],
      "openclaw.setup.auth.start handler",
    )({
      params: { sessionId: "auth-session-4", authChoice: "xai-oauth" },
      respond,
      context,
      signal: requestOwner.signal,
    } as never);
    await vi.waitFor(() => expect(calls[0]?.ok).toBe(true));
    const sessionId = startedWizardSessionId(calls);
    const session = expectDefined(
      trackedWizardSession(wizardSessions, sessionId),
      "provider login session",
    );
    const prompt = await callWizardNext(context, { sessionId });
    void callWizardNext(context, {
      sessionId,
      answer: { stepId: expectDefined(prompt.step, "device code step").id, value: null },
    });
    await persistenceStarted.promise;

    requestOwner.abort();
    expect(session.getStatus()).toBe("running");
    releasePersistence.resolve();

    await running;
    expect(persisted).toBe(true);
    expect(session.getStatus()).toBe("done");
    expect(wizardSessions.has(sessionId)).toBe(false);
  });

  it("runs guided secret auth through a masked wizard step", async () => {
    modelsAuthLoginMocks.resolveManifestProviderAuthChoice.mockReturnValueOnce({
      pluginId: "groq",
      providerId: "groq",
      methodId: "api-key",
      choiceId: "groq-api-key",
      choiceLabel: "Groq API key",
      appGuidedSecret: true,
    });
    modelsAuthLoginMocks.runModelsAuthLoginFlowCore.mockImplementationOnce(async (options) => {
      await options.prompter.text({
        message: "Enter Groq API key",
        initialValue: "must-not-cross-client-boundary",
        sensitive: true,
      });
      return {
        providerId: "groq",
        methodId: "api-key",
        profiles: [{ profileId: "groq:default", provider: "groq", mode: "api_key" }],
      };
    });
    const { context } = makeContext();
    const { calls, respond } = makeRespond();

    await expectDefined(
      systemAgentHandlers["openclaw.setup.auth.start"],
      "openclaw.setup.auth.start handler",
    )({
      params: { sessionId: "auth-session-5", authChoice: "groq-api-key" },
      respond,
      context,
    } as never);

    const sessionId = startedWizardSessionId(calls);
    const prompt = await callWizardNext(context, { sessionId });
    expect(prompt).toMatchObject({
      done: false,
      step: { type: "text", sensitive: true, message: "Enter Groq API key" },
    });
    expect(prompt.step).not.toHaveProperty("initialValue");
    const done = await callWizardNext(context, {
      sessionId,
      answer: { stepId: expectDefined(prompt.step, "secret prompt").id, value: "test-key" },
    });
    expect(done).toEqual({ done: true, status: "done" });
  });

  it("reports saved provider auth when model access could not be enabled", async () => {
    modelsAuthLoginMocks.runModelsAuthLoginFlowCore.mockResolvedValueOnce({
      providerId: "xai",
      methodId: "oauth",
      modelAccess: "failed",
      profiles: [{ profileId: "xai:owner", provider: "xai", mode: "oauth" }],
    });
    const { context } = makeContext();
    const { calls, respond } = makeRespond();

    await expectDefined(
      systemAgentHandlers["openclaw.setup.auth.start"],
      "openclaw.setup.auth.start handler",
    )({
      params: { sessionId: "auth-session-6", authChoice: "xai-oauth" },
      respond,
      context,
    } as never);

    await expect(
      callWizardNext(context, { sessionId: startedWizardSessionId(calls) }),
    ).resolves.toEqual({
      done: true,
      status: "error",
      error:
        "Error: xAI OAuth sign-in succeeded, but OpenClaw could not enable its models. Retry after the current config change finishes.",
    });
  });

  it("rejects a stale provider choice before starting a wizard", async () => {
    modelsAuthLoginMocks.resolveManifestProviderAuthChoice.mockReturnValueOnce(undefined);
    const { wizardSessions, context } = makeContext();
    const { calls, respond } = makeRespond();

    await expectDefined(
      systemAgentHandlers["openclaw.setup.auth.start"],
      "openclaw.setup.auth.start handler",
    )({
      params: { sessionId: "auth-session-7", authChoice: "removed-provider" },
      respond,
      context,
    } as never);

    expect(calls[0]).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("Refresh Models") },
    });
    expect(wizardSessions.size).toBe(0);
    expect(modelsAuthLoginMocks.runModelsAuthLoginFlowCore).not.toHaveBeenCalled();
  });
});
