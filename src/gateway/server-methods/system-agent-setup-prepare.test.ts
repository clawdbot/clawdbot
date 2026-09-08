import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WizardNextParams,
  WizardNextResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { WizardNextResultSchema } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { WizardSession } from "../../wizard/session.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const providerAuthChoiceMocks = vi.hoisted(() => ({
  prepareAuthChoiceLoadedPluginProvider: vi.fn(),
}));
const setupSharedMocks = vi.hoisted(() => ({
  readSetupConfigFileSnapshot: vi.fn(),
  writeWizardConfigFile: vi.fn(),
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

describe("openclaw.setup provider preparation", () => {
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

  it.each(["before credentials", "during credentials"])(
    "keeps provider preparation consistent when expiry occurs %s",
    async (expiryPoint) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { wizardSessions, context } = makeContext();
      const sessionId = "prepare-credential-commit";
      const preparationStarted = createDeferredCore();
      const finishPreparation = createDeferredCore();
      const credentialWriteStarted = createDeferredCore();
      const finishCredentialWrite = createDeferredCore();
      const preparedConfig: OpenClawConfig = {
        ...config,
        auth: { profiles: { "fixture:default": { provider: "fixture", mode: "api_key" } } },
      };
      const beforeCredentials = expiryPoint === "before credentials";
      let credentialsWritten = false;
      let session: WizardSession | undefined;
      const persistAuthProfiles = vi.fn();
      providerAuthChoiceMocks.prepareAuthChoiceLoadedPluginProvider.mockImplementationOnce(
        async (params) => {
          await params.prompter.confirm({ message: "Prepare provider?", initialValue: false });
          await params.beforePersistentEffect();
          preparationStarted.resolve();
          await finishPreparation.promise;
          persistAuthProfiles.mockImplementationOnce(async () => {
            await params.beforePersistentEffect();
            credentialWriteStarted.resolve();
            await finishCredentialWrite.promise;
            credentialsWritten = true;
          });
          return {
            config: preparedConfig,
            agentModelOverride: "fixture/demo-model",
            authProfiles: [],
            persistAuthProfiles,
          };
        },
      );
      try {
        await systemAgentHandler("openclaw.setup.prepare.start")({
          params: { sessionId, authChoice: "fixture-provider" },
          respond: () => undefined,
          context,
        } as never);
        session = expectDefined(wizardSessions.get(sessionId), "provider preparation wizard");
        const confirmation = await callWizardNext(context, { sessionId });
        const terminal = callWizardNext(context, {
          sessionId,
          answer: {
            stepId: expectDefined(confirmation.step, "prepare confirmation").id,
            value: true,
          },
        });
        await preparationStarted.promise;
        if (beforeCredentials) {
          await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
          expect(session.getStatus()).toBe("running");
          finishCredentialWrite.resolve();
        }
        finishPreparation.resolve();
        if (!beforeCredentials) {
          await credentialWriteStarted.promise;
          await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
          const { calls, respond } = makeRespond();
          await expectDefined(
            wizardHandlers["wizard.cancel"],
            "wizard cancel",
          )({
            params: { sessionId },
            respond,
            context,
          } as never);
          expect(calls[0]?.payload).toMatchObject({ status: "running" });
          expect(session.signal.aborted).toBe(false);
          expect(setupSharedMocks.writeWizardConfigFile).not.toHaveBeenCalled();
          finishCredentialWrite.resolve();
        }
        const done = await terminal;
        expect(credentialsWritten).toBe(!beforeCredentials);
        expect(persistAuthProfiles).toHaveBeenCalledTimes(beforeCredentials ? 0 : 1);
        expect(done).toMatchObject({
          done: true,
          status: beforeCredentials ? "cancelled" : "done",
        });
        if (beforeCredentials) {
          expect(setupSharedMocks.writeWizardConfigFile).not.toHaveBeenCalled();
          expect(done).not.toHaveProperty("preparedModelRef");
        } else {
          expect(setupSharedMocks.writeWizardConfigFile).toHaveBeenCalledWith(
            preparedConfig,
            expect.objectContaining({ baseHash: "setup-resolution-config" }),
          );
          expect(done.preparedModelRef).toBe("fixture/demo-model");
        }
        expect(wizardSessions.has(sessionId)).toBe(false);
      } finally {
        finishPreparation.resolve();
        finishCredentialWrite.resolve();
        session?.cancel();
        if (session) {
          await whenAdmittedWizardSessionSettled(session);
        }
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "runs provider preparation with native discovery preference %s",
    async (nativeSessionCatalogsEnabled) => {
      const preparedConfig: OpenClawConfig = {
        ...config,
        models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
      };
      const persistAuthProfiles = vi.fn();
      providerAuthChoiceMocks.prepareAuthChoiceLoadedPluginProvider.mockImplementationOnce(
        async (params) => {
          await params.prompter.note("Model ready", "Ollama");
          await params.beforePersistentEffect();
          return {
            config: preparedConfig,
            agentModelOverride: "ollama/qwen3:0.6b",
            authProfiles: [],
            persistAuthProfiles,
          };
        },
      );
      const { wizardSessions, context } = makeContext();
      const { calls, respond } = makeRespond();

      await systemAgentHandler("openclaw.setup.prepare.start")({
        params: {
          sessionId: "prepare-session-1",
          nativeSessionCatalogsEnabled,
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
      expect(providerAuthChoiceMocks.prepareAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
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
      expect(persistAuthProfiles).toHaveBeenCalledOnce();
      expect(setupSharedMocks.writeWizardConfigFile).toHaveBeenCalledWith(preparedConfig, {
        allowConfigSizeDrop: false,
        baseSnapshot: expect.objectContaining({ hash: "setup-resolution-config" }),
        baseHash: "setup-resolution-config",
      });
    },
  );
});
