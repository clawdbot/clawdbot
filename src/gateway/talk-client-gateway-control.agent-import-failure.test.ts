import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type ConsultParams = Parameters<
  typeof import("../talk/agent-consult-runtime.js").consultRealtimeVoiceAgent
>[0];

const mocks = vi.hoisted(() => ({
  consultRealtimeVoiceAgent: vi.fn(),
  createOperationalRunInstanceRef: vi.fn(),
  prepareAgentRunAdmission: vi.fn(),
}));

vi.mock("../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../agents/embedded-agent.js", () => {
  return {
    get runEmbeddedAgent() {
      throw new Error("embedded agent import failed");
    },
  };
});
vi.mock("../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));

import { createTalkClientAgentConsultRunner } from "./talk-client-gateway-control.js";

it("does not create Talk admission when lazy core loading fails", async () => {
  mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
    await params.agentRuntime.runEmbeddedAgent({
      config: {} as OpenClawConfig,
      prompt: "check",
      runId: "run-talk-import-failure",
      sessionId: "session-talk-import-failure",
      timeoutMs: 1,
      workspaceDir: "/tmp/workspace",
    });
    return { text: "unexpected" };
  });
  const runner = createTalkClientAgentConsultRunner({
    config: {} as OpenClawConfig,
    context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
    sessionTarget: {
      agentId: "main",
      sessionKey: "agent:main:talk",
      canonicalKey: "agent:main:talk",
      storePath: "/tmp/sessions",
    },
    getVoiceSessionId: () => "voice-session",
    initialItems: [],
    registerRun: vi.fn(),
  });

  await expect(runner.runPrompt({ prompt: "check" })).rejects.toThrow(
    "embedded agent import failed",
  );
  expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
});
