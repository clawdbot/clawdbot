import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  consumeRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../agents/subagents/requester-final-attachment.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";

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
vi.mock("../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));
vi.mock("../talk/agent-run-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../talk/agent-run-control.js")>()),
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

import {
  createTalkClientAgentConsultRunner,
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
    agentId: "researcher",
    sessionKey: "agent:researcher:talk",
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
      target: "embedded_run",
      message: "Got it. I steered the active run.",
      speak: true,
      show: true,
      suppress: false,
    });
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      const handle = createEmbeddedRunHandle({ runId: "run-talk" });
      const registration = params.onRunStarted?.({
        runId: "run-talk",
        sessionId: "session-talk",
        timeoutMs: 60_000,
      });
      setActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
      try {
        await params.agentRuntime.runEmbeddedAgent({
          ...coreParams,
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        });
        return { text: "done" };
      } finally {
        clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
        registration?.cleanup?.();
      }
    });
  });

  afterEach(() => {
    embeddedRunsTesting.resetActiveEmbeddedRuns();
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
      expect.objectContaining({ senderIsOwner: false, toolsAllow: ["read"] }),
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

  it("keeps one consult owner and steers newer provider delegations into its run", async () => {
    const core = deferred<{ payloads: never[] }>();
    mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    const isRunCurrent = vi.fn(() => true);
    const chatAbortControllers = new Map();
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      agentId: "researcher",
      sessionKey: "agent:researcher:talk",
      ownerConnId: "conn-owner",
      authority: { senderIsOwner: false, toolsAllow: ["read"] },
      getVoiceSessionId: () => "voice-session",
      initialItems: [],
      registerRun: vi.fn(),
      isRunCurrent,
    });

    const run = runner.runPrompt({ prompt: "first task" });
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());
    await runner.runPrompt.steer({ prompt: "newest task" });

    expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce();
    expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledWith({
      sessionKey: "agent:researcher:talk",
      text: "newest task",
      mode: "steer",
      expectedSessionId: "session-talk",
      expectedRunId: "run-talk",
    });
    core.resolve({ payloads: [] });
    await run;
    expect(chatAbortControllers.has("run-talk")).toBe(true);
    expect(runner.runPrompt.claimAppend()).toBe(true);
    expect(chatAbortControllers.has("run-talk")).toBe(false);
    expect(runner.runPrompt.claimAppend()).toBe(false);
    expect(isRunCurrent).toHaveBeenCalledWith("run-talk");
  });

  it("registers the provider late-final callback before a yielded run settles", async () => {
    const core = deferred<{ payloads: never[] }>();
    mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    const append = vi.fn(() => true);
    const runner = createRunner();

    const run = runner.runPrompt({
      prompt: "investigate",
      requesterFinal: { append },
    });
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());
    expect(
      promoteRequesterFinalAttachment({
        requesterAgentId: "researcher",
        requesterSessionKey: "agent:researcher:talk",
        requesterTurnRunId: "run-talk",
        batchRunIds: ["run-child"],
        rearmGeneration: 1,
      }),
    ).toBe(true);
    core.resolve({ payloads: [] });
    await expect(run).resolves.toEqual({ text: "done" });
    expect(runner.runPrompt.claimAppend()).toBe(true);
    expect(
      consumeRequesterFinalAttachment({
        requesterAgentId: "researcher",
        requesterSessionKey: "agent:researcher:talk",
        requesterSessionId: "session-talk",
        batchRunIds: ["run-child"],
        rearmGeneration: 1,
        text: "late final",
      }),
    ).toBe("appended");
    expect(append).toHaveBeenCalledExactlyOnceWith("late final");
    expect(getAgentEventLifecycleGeneration()).toEqual(expect.any(String));
  });

  it("rejects final append after another run reuses the embedded session id", async () => {
    const chatAbortControllers = new Map();
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      agentId: "researcher",
      sessionKey: "agent:researcher:talk",
      ownerConnId: "conn-owner",
      getVoiceSessionId: () => "voice-session",
      initialItems: [],
      registerRun: vi.fn(),
      isRunCurrent: () => true,
    });

    await runner.runPrompt({ prompt: "replaced" });
    setActiveEmbeddedRun(
      "session-talk",
      createEmbeddedRunHandle({ runId: "run-replacement" }),
      "agent:researcher:talk",
    );

    expect(runner.runPrompt.claimAppend()).toBe(false);
  });

  it("rejects final append after the exact voice-session run owner goes stale", async () => {
    let currentVoiceSessionId: string | undefined = "voice-session";
    let runCurrent = true;
    const chatAbortControllers = new Map();
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      agentId: "researcher",
      sessionKey: "agent:researcher:talk",
      ownerConnId: "conn-owner",
      getVoiceSessionId: () => currentVoiceSessionId,
      initialItems: [],
      registerRun: vi.fn(),
      isRunCurrent: () => runCurrent,
    });

    await runner.runPrompt({ prompt: "replaced" });
    const staleEntry = chatAbortControllers.get("run-talk");
    currentVoiceSessionId = "replacement-session";
    expect(runner.runPrompt.claimAppend()).toBe(false);

    currentVoiceSessionId = "voice-session";
    if (!staleEntry) {
      throw new Error("expected registered owner");
    }
    chatAbortControllers.set("run-talk", staleEntry);
    await runner.runPrompt({ prompt: "duplicate run id" });
    expect(runner.runPrompt.claimAppend()).toBe(false);
    chatAbortControllers.delete("run-talk");

    await runner.runPrompt({ prompt: "closed" });
    chatAbortControllers.get("run-talk")?.controller.abort(new Error("cancelled"));
    expect(runner.runPrompt.claimAppend()).toBe(false);

    await runner.runPrompt({ prompt: "superseded" });
    runCurrent = false;
    expect(runner.runPrompt.claimAppend()).toBe(false);
  });

  it("settles steering when consult startup fails before run registration", async () => {
    mocks.consultRealtimeVoiceAgent.mockRejectedValueOnce(new Error("startup failed"));
    const runner = createRunner();
    const run = runner.runPrompt({ prompt: "first" });

    await expect(runner.runPrompt.steer({ prompt: "newest" })).rejects.toThrow(
      "owner is no longer current",
    );
    await expect(run).rejects.toThrow("startup failed");
    expect(runner.runPrompt.claimAppend()).toBe(false);
  });

  it("does not claim final append when the embedded run never registers", async () => {
    const chatAbortControllers = new Map();
    mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
      params.onRunStarted?.({
        runId: "run-talk",
        sessionId: "session-talk",
        timeoutMs: 1,
      });
      return { text: "startup fallback" };
    });
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      agentId: "researcher",
      sessionKey: "agent:researcher:talk",
      ownerConnId: "conn-owner",
      getVoiceSessionId: () => "voice-session",
      initialItems: [],
      registerRun: vi.fn(),
      isRunCurrent: () => true,
    });

    await expect(runner.runPrompt({ prompt: "never started" })).resolves.toEqual({
      text: "startup fallback",
    });
    expect(runner.runPrompt.claimAppend()).toBe(false);
    expect(chatAbortControllers.has("run-talk")).toBe(false);
  });

  it("settles steering when startup is aborted before run registration", async () => {
    const consult = deferred<{ text: string }>();
    mocks.consultRealtimeVoiceAgent.mockReturnValueOnce(consult.promise);
    const controller = new AbortController();
    const runner = createRunner();
    const run = runner.runPrompt({ prompt: "first", signal: controller.signal });
    const steer = runner.runPrompt.steer({ prompt: "newest", signal: controller.signal });

    controller.abort(new Error("cancelled"));
    await expect(steer).rejects.toThrow("cancelled");
    consult.resolve({ text: "ignored" });
    await expect(run).resolves.toEqual({ text: "ignored" });
    expect(runner.runPrompt.claimAppend()).toBe(false);
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
});
