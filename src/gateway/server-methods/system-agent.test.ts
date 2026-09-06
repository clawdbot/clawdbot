// OpenClaw gateway tests cover activation serialization and chat sessions.
import "./system-agent.mocks.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  hashRuntimeConfigValue,
  setRuntimeConfigAppliedHash,
} from "../../config/runtime-snapshot.js";
import { createRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { defaultRuntime } from "../../runtime.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { SystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import type { ActivateSetupInferenceParams } from "../../system-agent/setup-inference.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { WizardSession } from "../../wizard/session.js";
import { runExclusiveSystemAgentSetupActivation } from "./setup-admission.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  inferenceFallbackMocks,
  makeContext,
  makeRespond,
  setupInferenceDetectionMocks,
  setupInferenceMocks,
  systemAgentHandler,
  systemAgentLane,
  transcriptStoreMocks,
  useSystemAgentGatewayTestFixture,
  verifiedConfig,
} from "./system-agent.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const {
  systemAgentTempDirs,
  requireVerifiedInferenceFixture,
  requireVerifiedInferenceDeps,
  makeVerifiedEngine,
  seededSession,
} = useSystemAgentGatewayTestFixture();

function makeWizardContext() {
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

const waitOneTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

async function makeVerificationContext() {
  const stateDir = systemAgentTempDirs.make("openclaw-setup-verification-");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  fs.writeFileSync(configPath, "{}\n");
  const snapshot = await readConfigFileSnapshot();
  setRuntimeConfigAppliedHash(hashRuntimeConfigValue(snapshot.sourceConfig));
  return {
    configPath,
    getRuntimeConfig: vi.fn(() => snapshot.runtimeConfig ?? snapshot.config),
    isConfigReloadSettled: vi.fn(() => true),
  };
}

async function runSensitiveChannelSetup(_channel: string, prompter: WizardPrompter) {
  await prompter.text({ message: "Bot token", sensitive: true });
}

function stubEngineOverview() {
  return vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview").mockResolvedValue({
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    agents: [],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { available: false },
      claude: { available: false },
      gemini: { available: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  } as never);
}

describe("openclaw.setup", () => {
  it("returns a retryable busy error while another activation is running", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const first = runExclusiveSystemAgentSetupActivation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    try {
      const { calls, respond } = makeRespond();
      await systemAgentHandler("openclaw.setup.activate")({
        params: { kind: "claude-cli" },
        respond,
      } as never);

      expect(calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: {
            code: "UNAVAILABLE",
            message: "OpenClaw setup is already in progress; try again when it finishes.",
            details: { code: "SETUP_ADMISSION_BUSY" },
            retryable: true,
          },
        },
      ]);
    } finally {
      releaseFirst.resolve();
      await first;
    }
  });

  it.each([
    ["openclaw.setup.activate.start" as const, { sessionId: "busy-activation", kind: "codex-cli" }],
    [
      "openclaw.setup.auth.start" as const,
      { sessionId: "busy-auth", authChoice: "github-copilot" },
    ],
    ["openclaw.setup.prepare.start" as const, { sessionId: "busy-prepare", authChoice: "ollama" }],
  ])("rejects %s before creating a wizard session when setup is busy", async (method, params) => {
    const ownerStarted = createDeferred();
    const releaseOwner = createDeferred();
    const owner = runExclusiveSystemAgentSetupActivation(async () => {
      ownerStarted.resolve();
      await releaseOwner.promise;
    });
    await ownerStarted.promise;
    const { wizardSessions, context } = makeWizardContext();

    try {
      const { calls, respond } = makeRespond();
      await systemAgentHandler(method)({ params, respond, context } as never);

      expect(calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: {
            code: "UNAVAILABLE",
            message: "OpenClaw setup is already in progress; try again when it finishes.",
            details: { code: "SETUP_ADMISSION_BUSY" },
            retryable: true,
          },
        },
      ]);
      expect(wizardSessions.size).toBe(0);
    } finally {
      releaseOwner.resolve();
      await owner;
    }
  });
});

describe("openclaw.chat", () => {
  it("refuses to create a session before inference is available", async () => {
    inferenceFallbackMocks.verify.mockResolvedValueOnce({
      ok: false,
      status: "unavailable",
      error: "no configured model",
    });
    const sessions = new Map<string, SystemAgentChatSession>();

    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "OpenClaw requires working inference: no configured model",
        details: {
          code: "system_agent_inference_unavailable",
        },
      },
    });
    expect(sessions.size).toBe(0);
    expect(inferenceFallbackMocks.verify).toHaveBeenCalledWith({
      runtime: defaultRuntime,
    });
  });

  it("coalesces concurrent initialization for the same session", async () => {
    stubEngineOverview();
    const started = createDeferred();
    const release = createDeferred();
    inferenceFallbackMocks.verify.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 10,
        binding: requireVerifiedInferenceFixture(),
      };
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);

    const first = callChat(context, { sessionId: "shared" });
    await started.promise;
    const second = callChat(context, { sessionId: "shared" });
    await waitOneTask();
    release.resolve();
    const [firstCall, secondCall] = await Promise.all([first, second]);

    expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(1);
    expect([firstCall.ok, secondCall.ok]).toEqual([true, true]);
  });

  it("keeps read-only setup detection outside the serialized system-agent lane", async () => {
    const started = createDeferred();
    const release = createDeferred();
    setupInferenceDetectionMocks.detectSetupInferenceIsolated.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { setupComplete: false } as never;
    });
    const activeAtResponse: number[] = [];

    const pending = systemAgentHandler("openclaw.setup.detect")({
      params: { agentId: "research" },
      respond: () => {
        activeAtResponse.push(systemAgentLane().activeCount);
      },
    } as never);

    await started.promise;
    expect(systemAgentLane().activeCount).toBe(0);
    release.resolve();
    await pending;

    expect(activeAtResponse).toEqual([0]);
    const [detectOptions] =
      setupInferenceDetectionMocks.detectSetupInferenceIsolated.mock.calls[0]!;
    expect(detectOptions?.agentId).toBe("research");
  });

  it.each([
    {
      name: "working",
      result: { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 25 },
    },
    {
      name: "unavailable",
      result: {
        ok: false as const,
        status: "unavailable" as const,
        error: "no configured model",
      },
    },
  ])("returns the structured $name inference verification result", async ({ result }) => {
    setupInferenceMocks.verifySetupInference.mockResolvedValueOnce(result);
    const { calls, respond } = makeRespond();

    const verify = systemAgentHandler("openclaw.setup.verify");
    await verify({
      params: { agentId: "research" },
      respond,
      context: await makeVerificationContext(),
    } as never);

    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledWith({
      agentId: "research",
      runtime: defaultRuntime,
    });
    expect(calls).toEqual([{ ok: true, payload: result, error: undefined }]);
  });

  it.each([
    { change: "unapplied revision", when: "before" },
    { change: "unknown revision", when: "before" },
    { change: "restart with unchanged config", when: "before" },
    { change: "unapplied revision", when: "during" },
    { change: "restart with unchanged config", when: "during" },
    { change: "replaced runtime", when: "during" },
  ])("rejects $change $when verification without false readiness", async ({ change, when }) => {
    const context = await makeVerificationContext();
    const changeRuntime = () => {
      if (change === "unapplied revision") {
        fs.writeFileSync(context.configPath, JSON.stringify({ logging: { level: "debug" } }));
      } else if (change === "unknown revision") {
        setRuntimeConfigAppliedHash(null);
      } else if (change === "replaced runtime") {
        context.getRuntimeConfig.mockReturnValue({ ...verifiedConfig });
      } else {
        context.isConfigReloadSettled.mockReturnValue(false);
      }
    };
    if (when === "before") {
      changeRuntime();
    } else {
      setupInferenceMocks.verifySetupInference.mockImplementationOnce(async () => {
        changeRuntime();
        return { ok: true, modelRef: "openai/gpt-5.6-luna", latencyMs: 1 };
      });
    }
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.verify")({ params: {}, respond, context } as never);

    expect(calls).toEqual([
      {
        ok: true,
        payload: {
          ok: false,
          status: "unavailable",
          error: expect.stringContaining("not active"),
        },
        error: undefined,
      },
    ]);
    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledTimes(
      when === "before" ? 0 : 1,
    );
  });

  it("rejects unknown setup verification params without running inference", async () => {
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.verify")({
      params: { modelRef: "openai/gpt-5.5" },
      respond,
    } as never);

    expect(setupInferenceMocks.verifySetupInference).not.toHaveBeenCalled();
    expect(calls[0]?.ok).toBe(false);
  });

  it.each([
    "applied",
    "applied-restart-required",
    "restart-pending",
    "failed",
    "stopped",
    "superseded",
  ] as const)(
    "settles setup after the Gateway application receipt without holding its lane: %s",
    async (outcome) => {
      const application = createRuntimeConfigWriteApplication();
      const claim = expectDefined(application.claim(), "application claim");
      const result = {
        ok: true as const,
        modelRef: "openai/gpt-5.6-luna",
        latencyMs: 1,
        lines: [],
      };
      setupInferenceMocks.activateSetupInference.mockImplementation(
        async (params: ActivateSetupInferenceParams) => {
          params.onRuntimeApplication?.(application);
          return result;
        },
      );
      const { calls, respond } = makeRespond();
      const pending = systemAgentHandler("openclaw.setup.activate")({
        params: { kind: "codex-cli" },
        respond,
      } as never);
      try {
        await vi.waitFor(() =>
          expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce(),
        );
        await waitOneTask();
        expect(calls).toEqual([]);
        expect(systemAgentLane().activeCount).toBe(0);
        await systemAgentHandler("openclaw.setup.verify")({
          params: {},
          respond: () => {},
          context: await makeVerificationContext(),
        } as never);
        expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledOnce();
      } finally {
        claim.settle(outcome);
        if (
          outcome === "applied" ||
          outcome === "applied-restart-required" ||
          outcome === "restart-pending"
        ) {
          await pending;
        } else {
          await expect(pending).rejects.toThrow(
            outcome === "superseded" ? "newer settings" : "Restart the Gateway before chatting",
          );
        }
      }
      if (
        outcome === "applied" ||
        outcome === "applied-restart-required" ||
        outcome === "restart-pending"
      ) {
        expect(calls).toEqual([
          {
            ok: true,
            payload: outcome === "applied" ? result : { ...result, gatewayRestartRequired: true },
            error: undefined,
          },
        ]);
      } else {
        // The RPC error stops automatic candidate fallthrough after a saved choice.
        expect(calls).toEqual([]);
      }
    },
  );

  it("reports restart required when the committed setup application is unclaimed", async () => {
    setupInferenceMocks.activateSetupInference.mockImplementation(
      async (params: ActivateSetupInferenceParams) => {
        params.onRuntimeApplication?.(createRuntimeConfigWriteApplication());
        return { ok: true, modelRef: "openai/gpt-5.6-luna", latencyMs: 1, lines: [] };
      },
    );
    const { calls, respond } = makeRespond();
    await expect(
      systemAgentHandler("openclaw.setup.activate")({
        params: { kind: "codex-cli" },
        respond,
      } as never),
    ).rejects.toThrow("Restart the Gateway before chatting");
    expect(calls).toEqual([]);
  });

  it.each(["success", "task error", "response error"])(
    "keeps admitted setup on the gateway lane without relabeling %s as non-admission",
    async (outcome) => {
      const failure = new Error("admitted operation failed");
      const started = createDeferred();
      const release = createDeferred();
      const activationResult = {
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 250,
        lines: ["Default model: openai/gpt-5.5"],
      };
      setupInferenceMocks.activateSetupInference.mockImplementation(async () => {
        started.resolve();
        await release.promise;
        if (outcome === "task error") {
          throw failure;
        }
        return activationResult;
      });
      const { calls, respond } = makeRespond();
      const activeAtResponse: number[] = [];

      const pending = systemAgentHandler("openclaw.setup.activate")({
        params: {
          kind: "api-key",
          agentId: "research",
          modelRef: "openai/gpt-5.5",
          authChoice: "openai-api-key",
          apiKey: "test-key",
          workspace: "/tmp/work",
        },
        respond: (ok: boolean, payload?: unknown, error?: unknown) => {
          activeAtResponse.push(systemAgentLane().activeCount);
          if (outcome === "response error") {
            throw failure;
          }
          respond(ok, payload, error);
        },
      } as never);

      await started.promise;
      expect(systemAgentLane().activeCount).toBe(1);
      release.resolve();
      if (outcome === "success") {
        await pending;
      } else {
        await expect(pending).rejects.toBe(failure);
      }

      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith({
        kind: "api-key",
        agentId: "research",
        modelRef: "openai/gpt-5.5",
        authChoice: "openai-api-key",
        apiKey: "test-key",
        workspace: "/tmp/work",
        surface: "gateway",
        runtime: expect.objectContaining({ exit: expect.any(Function) }),
        onRuntimeApplication: expect.any(Function),
      });
      expect(calls).toEqual(
        outcome === "success" ? [{ ok: true, payload: activationResult, error: undefined }] : [],
      );
      expect(activeAtResponse).toEqual(outcome === "task error" ? [] : [0]);
      expect(systemAgentLane().activeCount).toBe(0);
    },
  );

  it("rejects invalid params", async () => {
    const call = await callChat(makeContext(new Map()), {});
    expect(call.ok).toBe(false);
  });

  it("trims, canonicalizes, and forwards valid UI context for a user turn", async () => {
    const engine = makeVerifiedEngine();
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "Everything is healthy.", action: "none" });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "What about this page?",
      context: { page: "  /settings/channels  ", source: "client" },
    });

    expect(call.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("What about this page?", {
      uiContext: { page: "/settings/channels" },
    });
  });

  it.each([
    { name: "unsafe characters", page: "channels?tab=all" },
    { name: "an overlong id", page: "a".repeat(65) },
    { name: "a Unicode case-folding character", page: "\u212A" },
  ])("drops UI context with $name without rejecting the turn", async ({ page }) => {
    const engine = makeVerifiedEngine();
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "Everything is healthy.", action: "none" });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "Status please.",
      context: { page },
    });

    expect(call.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("Status please.");
  });

  it("does not pass UI context to welcome-only turns", async () => {
    const engine = makeVerifiedEngine();
    const handle = vi.spyOn(engine, "handle");
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      context: { page: "custodian" },
    });

    expect(call.ok).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });

  it("persists completed turns from the engine's sanitized history", async () => {
    const engine = new SystemAgentChatEngine({
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: requireVerifiedInferenceDeps(),
      runAgentTurn: async () => ({ text: "Everything is healthy." }),
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "How is this machine doing?",
      context: { page: "dashboard" },
    });

    expect(call.payload).toMatchObject({ reply: "Everything is healthy." });
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalledTimes(2);
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: "user", text: "How is this machine doing?" }),
    );
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ role: "assistant", text: "Everything is healthy." }),
    );
    expect(JSON.stringify(transcriptStoreMocks.appendTranscriptTurn.mock.calls)).not.toContain(
      "ui-context",
    );
  });

  it("seeds a new engine with the persisted tail without recording an idle welcome", async () => {
    stubEngineOverview();
    transcriptStoreMocks.readTranscriptTail.mockReturnValue([
      { role: "user", text: "Earlier question", at: 1 },
      { role: "assistant", text: "Earlier answer", at: 2 },
    ]);
    const seedHistory = vi.spyOn(SystemAgentChatEngine.prototype, "seedHistory");

    const call = await callChat(makeContext(new Map()), { sessionId: "fresh" });

    expect(call.ok).toBe(true);
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenCalledWith(30, {
      afterLastReset: true,
    });
    expect(seedHistory).toHaveBeenCalledWith([
      { role: "user", text: "Earlier question" },
      { role: "assistant", text: "Earlier answer" },
    ]);
    expect(transcriptStoreMocks.appendTranscriptTurn).not.toHaveBeenCalled();
  });

  it("persists only the mask marker for a sensitive hosted-wizard answer", async () => {
    const engine = new SystemAgentChatEngine(
      {
        surface: "gateway",
        verifiedInference: requireVerifiedInferenceFixture(),
        deps: requireVerifiedInferenceDeps(),
        runAgentTurn: async () => null,
      },
      { wizardDependencies: { runChannelSetupWizard: runSensitiveChannelSetup } },
    );
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const prompt = await callChat(context, { sessionId: "s1", message: "connect telegram" });
    expect(prompt.payload).toMatchObject({ sensitive: true, wizardInputPending: true });
    transcriptStoreMocks.appendTranscriptTurn.mockClear();

    await callChat(context, { sessionId: "s1", message: "raw-secret-value" });

    const persisted = transcriptStoreMocks.appendTranscriptTurn.mock.calls.map(([turn]) => turn);
    expect(persisted).toContainEqual(
      expect.objectContaining({ role: "user", text: "<redacted secret>" }),
    );
    expect(JSON.stringify(persisted)).not.toContain("raw-secret-value");
  });

  it("returns history oldest-first with default and explicit bounded limits", async () => {
    const turns = [
      { role: "user" as const, text: "one", at: 1 },
      { role: "assistant" as const, text: "two", at: 2 },
    ];
    transcriptStoreMocks.readTranscriptTail.mockImplementation((limit: number) =>
      turns.slice(-limit),
    );
    const invoke = async (params: Record<string, unknown>) => {
      const { calls, respond } = makeRespond();
      await systemAgentHandler("openclaw.chat.history")({ params, respond } as never);
      return calls[0];
    };

    expect(await invoke({})).toEqual({ ok: true, payload: { turns }, error: undefined });
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenLastCalledWith(100);
    expect(await invoke({ limit: 1 })).toEqual({
      ok: true,
      payload: { turns: [turns[1]] },
      error: undefined,
    });
    expect((await invoke({ limit: 501 }))?.ok).toBe(false);
  });

  it("reuses a live session, then requires fresh fallback verification after failure", async () => {
    stubEngineOverview();
    const engine = new SystemAgentChatEngine({
      verifiedInference: requireVerifiedInferenceFixture(),
      runAgentTurn: async () => {
        throw new SystemAgentInferenceUnavailableError("agent-turn", [
          new Error("workspace owner openclaw is missing from the roster"),
        ]);
      },
      deps: requireVerifiedInferenceDeps(),
    });
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const failed = await callChat(context, { sessionId: "s1", message: "status please" });

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("workspace owner openclaw is missing from the roster"),
        details: { code: "system_agent_session_invalidated" },
      },
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(false);
    expect(inferenceFallbackMocks.verify).not.toHaveBeenCalled();

    const retried = await callChat(context, { sessionId: "s1" });

    expect(retried.ok).toBe(true);
    expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(true);
  });

  it("does not relabel unrelated session failures as inference errors", async () => {
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockRejectedValue(new Error("wizard bug"));
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    await expect(
      callChat(makeContext(sessions), { sessionId: "s1", message: "status please" }),
    ).rejects.toThrow("wizard bug");
    expect(sessions.has("s1")).toBe(true);
  });
});
