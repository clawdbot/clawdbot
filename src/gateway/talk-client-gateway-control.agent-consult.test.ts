import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    sessionTarget: {
      agentId: "researcher",
      sessionKey: "agent:researcher:talk",
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
    mocks.prepareAgentRunAdmission.mockReturnValue({
      operationalRunInstance: { instanceId: "instance:run-talk", runId: "run-talk" },
      admit: vi.fn(),
      close: mocks.close,
    });
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      await params.agentRuntime.runEmbeddedAgent({
        ...coreParams,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      });
      return { text: "done" };
    });
  });

  afterEach(() => resetClientVoiceConfirmationStateForTest());

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
