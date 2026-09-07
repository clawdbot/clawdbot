import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
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
    mocks.createOperationalRunInstanceRef.mockImplementation((runId: string) => ({
      instanceId: `instance:${runId}`,
      runId,
    }));
    mocks.prepareAgentRunAdmission.mockImplementation(
      (params: { operationalRunInstance: OperationalRunInstanceRef }) => ({
        operationalRunInstance: params.operationalRunInstance,
        admit: vi.fn(),
        close: mocks.close,
      }),
    );
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

  it.each(["success", "failure"] as const)(
    "keeps the released provider callback reusable after %s",
    async (outcome) => {
      if (outcome === "failure") {
        mocks.consultRealtimeVoiceAgent.mockRejectedValueOnce(new Error("consult failed"));
      }
      const runner = createRunner();
      const first = runner.runPrompt({ prompt: "first task" });
      if (outcome === "failure") {
        await expect(first).rejects.toThrow("consult failed");
      } else {
        await expect(first).resolves.toEqual({ text: "done" });
      }
      await expect(runner.runPrompt({ prompt: "second task" })).resolves.toEqual({
        text: "done",
      });
    },
  );

  it.each(["runOwnedArgs", "runPrompt"] as const)(
    "steers and claims only the exact registered consult owner through %s",
    async (entrypoint) => {
      const core = deferred<void>();
      const chatAbortControllers = new Map();
      const isRunCurrent = vi.fn(() => true);
      const operationalRunInstance = {
        instanceId: `instance:${entrypoint}`,
        runId: "run-talk",
      };
      mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
      mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
        const handle = createEmbeddedRunHandle({ runId: "run-talk" });
        await withGatewayToolCallerIdentity(
          {
            agentId: "researcher",
            sessionKey: "agent:researcher:talk",
            operationalRunInstance,
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
        return { payloads: [] };
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
      if (entrypoint === "runPrompt") {
        runner.runPrompt.adoptCompletionClaims();
      }
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
    const operationalRunInstance = {
      instanceId: "instance:publication",
      runId: "run-talk",
    };
    const projectToolAuthority = vi.fn(() => "authority");
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      announced.resolve();
      await publish.promise;
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
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
      return { payloads: [] };
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
    runner.runPrompt.adoptCompletionClaims();
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

  it("refreshes steering authority when the admitted run publishes a new attempt", async () => {
    const secondPublished = deferred<void>();
    const finish = deferred<void>();
    const chatAbortControllers = new Map();
    const firstHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const secondHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const operationalRunInstance = {
      instanceId: "instance:retry",
      runId: "run-talk",
    };
    let firstLive = true;
    const firstProject = vi.fn(() => {
      if (!firstLive) {
        throw new Error("first attempt expired");
      }
      return "first-authority";
    });
    const secondProject = vi.fn(() => "second-authority");
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: firstProject,
            assertActive: () => {
              if (!firstLive) {
                throw new Error("first attempt expired");
              }
            },
          }),
        },
        () => setActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk"),
      );
      await Promise.resolve();
      firstLive = false;
      clearActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk");
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: secondProject,
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk"),
      );
      secondPublished.resolve();
      await finish.promise;
      clearActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk");
      return { payloads: [] };
    });
    mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
      params.getToolAuthorityOverlay?.();
      return {
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
      };
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
      isRunCurrent: () => true,
    });
    runner.runPrompt.adoptCompletionClaims();
    const run = runner.runPrompt({ prompt: "first task" });
    await secondPublished.promise;

    try {
      await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).resolves.toEqual({
        text: "",
      });
      expect(firstProject).not.toHaveBeenCalled();
      expect(secondProject).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await run;
    }
  });

  it("rejects steering when a replacement reuses the run id from another admission", async () => {
    const secondPublished = deferred<void>();
    const finish = deferred<void>();
    const outbound = vi.fn();
    const admittedRun = { instanceId: "instance:owner", runId: "run-talk" };
    const replacementRun = { instanceId: "instance:replacement", runId: "run-talk" };
    const firstHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const secondHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const replacementProject = vi.fn(() => "replacement-authority");
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(admittedRun);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance: admittedRun,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: () => "owner-authority",
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk"),
      );
      clearActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk");
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance: replacementRun,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: replacementProject,
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk"),
      );
      secondPublished.resolve();
      await finish.promise;
      clearActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk");
      return { payloads: [] };
    });
    mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
      params.getToolAuthorityOverlay?.();
      outbound();
      throw new Error("unexpected outbound enqueue");
    });
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
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
      isRunCurrent: () => true,
    });
    runner.runPrompt.adoptCompletionClaims();
    const run = runner.runPrompt({ prompt: "first task" });
    await secondPublished.promise;

    try {
      await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).rejects.toThrow(
        "backend is no longer current",
      );
      expect(replacementProject).not.toHaveBeenCalled();
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await run;
    }
  });

  it("does not let a stale runtime bind a replacement owner before admission", async () => {
    const firstAnnounced = deferred<void>();
    const secondAnnounced = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const staleRun = { instanceId: "instance:stale", runId: "run-talk" };
    const currentRun = { instanceId: "instance:current", runId: "run-talk" };
    let invocation = 0;
    mocks.createOperationalRunInstanceRef
      .mockReturnValueOnce(staleRun)
      .mockReturnValueOnce(currentRun);
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      invocation += 1;
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      if (invocation === 1) {
        firstAnnounced.resolve();
        await releaseFirst.promise;
      } else {
        secondAnnounced.resolve();
        await releaseSecond.promise;
      }
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "done" };
    });
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
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
      isRunCurrent: () => true,
    });
    runner.runPrompt.adoptCompletionClaims();
    const first = runner.runPrompt({ prompt: "first task" });
    await firstAnnounced.promise;
    expect(runner.runPrompt.claimFailureAppend()).toBe(true);
    const second = runner.runPrompt({ prompt: "replacement task" });
    await secondAnnounced.promise;

    try {
      releaseFirst.resolve();
      await expect(first).rejects.toThrow("admission is no longer current");
      releaseSecond.resolve();
      await expect(second).resolves.toEqual({ text: "done" });
      expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledOnce();
      expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ operationalRunInstance: currentRun }),
      );
      expect(runner.runPrompt.claimFailureAppend()).toBe(true);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, second]);
      runner.runPrompt.claimFailureAppend();
    }
  });

  it("rejects a stale owner before it can announce over its replacement", async () => {
    const firstWaiting = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondPublished = deferred<void>();
    const finishSecond = deferred<void>();
    const chatAbortControllers = new Map();
    const registerRun = vi.fn();
    const currentRun = { instanceId: "instance:current-owner", runId: "run-talk" };
    const secondHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const project = vi.fn(() => "current-authority");
    let invocation = 0;
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(currentRun);
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      invocation += 1;
      if (invocation === 1) {
        firstWaiting.resolve();
        await releaseFirst.promise;
        params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
        await params.agentRuntime.runEmbeddedAgent(coreParams);
        return { text: "stale" };
      }
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "current" };
    });
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance: currentRun,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project,
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk"),
      );
      secondPublished.resolve();
      await finishSecond.promise;
      clearActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk");
      return { payloads: [] };
    });
    mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
      params.getToolAuthorityOverlay?.();
      return {
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
      };
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
      registerRun,
      isRunCurrent: () => true,
    });
    runner.runPrompt.adoptCompletionClaims();
    const first = runner.runPrompt({ prompt: "first task" });
    await firstWaiting.promise;
    expect(runner.runPrompt.claimFailureAppend()).toBe(true);
    const second = runner.runPrompt({ prompt: "replacement task" });
    await secondPublished.promise;

    try {
      releaseFirst.resolve();
      await expect(first).rejects.toThrow("admission is no longer current");
      await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).resolves.toEqual({
        text: "",
      });
      expect(registerRun).toHaveBeenCalledOnce();
      expect(project).toHaveBeenCalledOnce();
    } finally {
      releaseFirst.resolve();
      finishSecond.resolve();
      await Promise.allSettled([first, second]);
      runner.runPrompt.claimFailureAppend();
    }
  });

  it("installs steering ownership before readiness and delays backend admission", async () => {
    const ready = deferred<void>();
    const finish = deferred<void>();
    const chatAbortControllers = new Map();
    const handle = createEmbeddedRunHandle({ runId: "run-talk" });
    const operationalRunInstance = {
      instanceId: "instance:readiness",
      runId: "run-talk",
    };
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: () => "authority",
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk"),
      );
      await finish.promise;
      clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
      return { payloads: [] };
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
      isRunCurrent: () => true,
    });
    const readiness = vi.fn(() => ready.promise);
    const run = runner.runOwnedArgs(
      { question: "first task" },
      new AbortController().signal,
      readiness,
    );
    const steer = runner.runOwnedArgs.steer;
    if (!steer) {
      throw new Error("owned Talk runner did not expose steering");
    }
    const steering = steer({ prompt: "latest task" });

    try {
      expect(readiness).toHaveBeenCalledOnce();
      expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
      ready.resolve();
      await steering;
      expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce();
      expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledOnce();
      finish.resolve();
      await expect(run).resolves.toEqual({ text: "done" });
    } finally {
      ready.resolve();
      finish.resolve();
      await steering.catch(() => undefined);
      await run.catch(() => undefined);
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
