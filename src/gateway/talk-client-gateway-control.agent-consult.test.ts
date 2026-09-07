import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  authorizeClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  deactivateClientVoiceConfirmationSession,
  noteClientVoiceConfirmationUtterance,
} from "../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../talk/client-voice-confirmation.test-support.js";

type ConsultParams = Parameters<
  typeof import("../talk/agent-consult-runtime.js").consultRealtimeVoiceAgent
>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  prepareAgentRunAdmission: vi.fn(),
  runEmbeddedAgentCore: vi.fn(),
  controlRealtimeVoiceAgentRun: vi.fn(),
}));

vi.mock("../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../talk/agent-consult-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../talk/agent-consult-runtime.js")>()),
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));
vi.mock("../talk/agent-run-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../talk/agent-run-control.js")>()),
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import { createTalkClientAgentConsultRunner } from "./talk-client-agent-consult.js";
import {
  resolveTalkAgentConsultAuthority,
  type TalkAgentConsultAuthority,
} from "./talk-client-gateway-control.js";

const config = {} as OpenClawConfig;
const coreParams = {
  config,
  prompt: "check",
  runId: "run-talk",
  sessionId: "session-talk",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-talk",
    sessionKey: "agent:researcher:talk",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

function createRunner(
  registerRun = vi.fn(),
  authority: TalkAgentConsultAuthority = { senderIsOwner: false, toolsAllow: ["read"] },
) {
  return createTalkClientAgentConsultRunner({
    config,
    context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
    sessionTarget: {
      agentId: "researcher",
      sessionKey: "main",
      canonicalKey: "agent:researcher:talk",
      storePath: "/tmp/sessions",
    },
    authority,
    getVoiceSessionId: () => "voice-session",
    initialItems: [],
    registerRun,
  });
}

describe("Talk client agent consult admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    mocks.prepareAgentRunAdmission.mockReturnValue({
      operationalRunInstance: { instanceId: "instance:run-talk", runId: "run-talk" },
      admit: vi.fn(),
      close: mocks.close,
    });
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue({
      ok: true,
      mode: "steer",
      sessionKey: "agent:researcher:talk",
      sessionId: "session-talk",
      active: true,
      queued: true,
      target: "embedded",
      message: "Steering accepted.",
      speak: true,
      show: true,
      suppress: false,
    });
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      await params.agentRuntime.runEmbeddedAgent({
        ...coreParams,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      });
      return { text: "done" };
    });
  });

  afterEach(() => {
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    resetClientVoiceConfirmationStateForTest();
  });

  it("runs through a Talk-owned gateway admission and closes it after success", async () => {
    await expect(createRunner().runPrompt({ prompt: "check" })).resolves.toEqual({ text: "done" });

    expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith({
      cfg: config,
      operationalRunInstance: { instanceId: "instance:run-talk", runId: "run-talk" },
      facts: {
        runId: "run-talk",
        agentId: "researcher",
        ingress: {
          kind: "gateway-client",
          boundary: "talk-agent-consult",
          state: "present",
        },
      },
    });
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({
        ...coreParams,
        preparedRunAdmission: expect.objectContaining({ close: mocks.close }),
      }),
    );
    expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "researcher",
        sessionKey: "agent:researcher:talk",
        storePath: "/tmp/sessions",
        senderIsOwner: false,
        toolsAllow: ["read"],
      }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("preserves full agent authority for administrator consults", async () => {
    await expect(
      createRunner(vi.fn(), { senderIsOwner: true }).runPrompt({ prompt: "check" }),
    ).resolves.toEqual({ text: "done" });

    expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
    expect(mocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0]).not.toHaveProperty("toolsAllow");
  });

  it("does not advertise steering without a connection owner", () => {
    expect(createRunner().runPrompt).not.toHaveProperty("steer");
  });

  it.each(["runOwnedArgs", "runPrompt"] as const)(
    "steers and claims only the exact registered consult owner through %s",
    async (entrypoint) => {
      const core = deferred<void>();
      const chatAbortControllers = new Map();
      const isRunCurrent = vi.fn(() => true);
      mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
        const handle = createEmbeddedRunHandle({ runId: "run-talk" });
        params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
        await withGatewayToolCallerIdentity(
          {
            agentId: "researcher",
            sessionKey: "agent:researcher:talk",
            embeddedRunToolAuthorityBinding: () => ({
              source: "attempt",
              project: () => "authority",
              assertActive: () => {},
            }),
          },
          () => setActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk"),
        );
        await core.promise;
        clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
        return { text: "done" };
      });
      const runner = createTalkClientAgentConsultRunner({
        config,
        context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
        sessionTarget: {
          agentId: "researcher",
          sessionKey: "main",
          canonicalKey: "agent:researcher:talk",
          storePath: "/tmp/sessions",
        },
        ownerConnId: "connection-owner",
        getVoiceSessionId: () => "voice-session",
        initialItems: [],
        registerRun: vi.fn(),
        isRunCurrent,
      });

      const lifecycleRunner = runner[entrypoint];
      const run =
        entrypoint === "runOwnedArgs"
          ? runner.runOwnedArgs({ question: "first task" }, new AbortController().signal)
          : runner.runPrompt({ prompt: "first task" });
      await vi.waitFor(() => expect(chatAbortControllers.has("run-talk")).toBe(true));
      const steer = lifecycleRunner.steer;
      if (!steer) {
        throw new Error("owned Talk runner did not expose steering");
      }
      await steer({ prompt: "latest task" });

      expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:researcher:talk",
          runTarget: expect.objectContaining({
            runId: "run-talk",
            signal: expect.any(AbortSignal),
            isCurrent: expect.any(Function),
          }),
          getToolAuthorityOverlay: expect.any(Function),
          text: "latest task",
          mode: "steer",
        }),
      );
      core.resolve();
      await expect(run).resolves.toEqual({ text: "done" });
      expect(lifecycleRunner.claimAppend()).toBe(true);
      expect(lifecycleRunner.claimAppend()).toBe(false);
      expect(chatAbortControllers.has("run-talk")).toBe(false);
      expect(isRunCurrent).toHaveBeenCalledWith("run-talk");
    },
  );

  it("waits for backend publication and projects its registered caller authority", async () => {
    const announced = deferred<void>();
    const publish = deferred<void>();
    const finish = deferred<void>();
    const chatAbortControllers = new Map();
    const client = sharingPolicyClient({
      deviceId: "caller-device",
      scopes: ["operator.admin"],
    });
    const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
    const handle = createEmbeddedRunHandle({ runId: "run-talk" });
    const projectToolAuthority = vi.fn(() => "authority");
    mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      announced.resolve();
      await publish.promise;
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          embeddedRunToolAuthorityBinding: () => ({
            source: "reply",
            project: projectToolAuthority,
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk"),
      );
      await finish.promise;
      clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
      return { text: "done" };
    });
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      sessionTarget: {
        agentId: "researcher",
        sessionKey: "main",
        canonicalKey: "agent:researcher:talk",
        storePath: "/tmp/sessions",
      },
      ownerConnId: "connection-owner",
      authority,
      getVoiceSessionId: () => "voice-session",
      initialItems: [],
      registerRun: vi.fn(),
      isRunCurrent: () => true,
    });
    const run = runner.runPrompt({ prompt: "first task" });
    await announced.promise;
    const steer = runner.runPrompt.steer;
    if (!steer) {
      throw new Error("owned Talk runner did not expose steering");
    }
    const steering = steer({ prompt: "latest task" });

    try {
      await Promise.resolve();
      expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
      publish.resolve();
      await steering;

      const controlParams = mocks.controlRealtimeVoiceAgentRun.mock.calls[0]?.[0];
      expect(controlParams).toEqual(
        expect.objectContaining({
          sessionKey: "agent:researcher:talk",
          runTarget: expect.objectContaining({ runId: "run-talk" }),
          getToolAuthorityOverlay: expect.any(Function),
          text: "latest task",
          mode: "steer",
        }),
      );
      const expectedOverlay = runner.getToolAuthorityOverlay(authority, "reply");
      expect(controlParams?.getToolAuthorityOverlay?.()).toEqual(expectedOverlay);
      expect(projectToolAuthority).toHaveBeenCalledWith(expectedOverlay);
    } finally {
      publish.resolve();
      finish.resolve();
      await steering.catch(() => undefined);
      await run;
    }
  });

  it("closes the Talk admission when core execution fails", async () => {
    mocks.runEmbeddedAgentCore.mockRejectedValueOnce(new Error("core failed"));

    await expect(createRunner().runPrompt({ prompt: "check" })).rejects.toThrow("core failed");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("revokes admission immediately when the composite run signal aborts", async () => {
    const core = deferred<{ payloads: never[] }>();
    mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    const controller = new AbortController();
    const run = createRunner().runPrompt({ prompt: "check", signal: controller.signal });
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());

    controller.abort(new Error("cancelled"));
    expect(mocks.close).toHaveBeenCalledOnce();
    core.resolve({ payloads: [] });
    await expect(run).resolves.toEqual({ text: "done" });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes admission when abort races with listener registration", async () => {
    const controller = new AbortController();
    mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
      controller.abort(new Error("raced cancellation"));
      return {
        operationalRunInstance: { instanceId: "instance:run-talk", runId: "run-talk" },
        admit: vi.fn(),
        close: mocks.close,
      };
    });

    await expect(
      createRunner().runPrompt({ prompt: "check", signal: controller.signal }),
    ).rejects.toThrow("raced cancellation");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("does not create admission for an already-aborted consult", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(
      createRunner().runPrompt({ prompt: "check", signal: controller.signal }),
    ).rejects.toThrow("already cancelled");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("does not create admission when run registration fails", async () => {
    const registerRun = vi.fn(() => {
      throw new Error("registration failed");
    });

    await expect(createRunner(registerRun).runPrompt({ prompt: "check" })).rejects.toThrow(
      "registration failed",
    );
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("continues the admitted run when close invalidates confirmation before registration", async () => {
    const now = Date.now();
    const challenge = checkClientVoiceToolConfirmationPolicy({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      runId: "run-original",
      toolName: "message",
      toolParams: { action: "send", message: "cancelled action" },
      now,
    });
    if (challenge.allowed) {
      throw new Error("expected voice confirmation challenge");
    }
    const confirmationId = challenge.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
    if (!confirmationId) {
      throw new Error("missing voice confirmation id");
    }
    noteClientVoiceConfirmationUtterance({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      text: "yes",
      timestamp: now + 1,
    });
    authorizeClientVoiceConfirmation({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      confirmationId,
      now: now + 2,
    });
    mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
      deactivateClientVoiceConfirmationSession("researcher", "voice-session");
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "done" };
    });
    const registerRun = vi.fn();

    await expect(
      createRunner(registerRun).runArgs({ question: "check", confirmationId }),
    ).resolves.toEqual({ text: "done" });
    expect(registerRun).toHaveBeenCalledWith({ runId: "run-talk" });
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
