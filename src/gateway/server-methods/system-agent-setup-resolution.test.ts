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
import { buildPluginCapabilityConsentReview } from "../../plugins/capability-consent.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createPluginCapabilityConsentPrompter } from "../../wizard/plugin-capability-consent.js";
import { WizardSession } from "../../wizard/session.js";
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
  it.each(["failed", "cancelled"] as const)(
    "does not report verified activation for %s provider auth",
    async (outcome) => {
      const { wizardSessions, context } = makeContext();
      const sessionId = "unverified-auth";
      setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
        await params.prompter.confirm({ message: "Continue sign-in?" });
        return { ok: false, status: "auth", error: "Provider rejected sign-in" };
      });
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
      } else {
        const done = await callWizardNext(context, {
          sessionId,
          answer: { stepId: expectDefined(first.step, "auth confirmation step").id, value: true },
        });
        expect(done).toEqual({
          done: true,
          status: "error",
          error: "Error: Provider rejected sign-in",
        });
      }
      expect(wizardSessions.has(sessionId)).toBe(false);
    },
  );
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
      wizardSessions.get("prepare-session-1"),
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
