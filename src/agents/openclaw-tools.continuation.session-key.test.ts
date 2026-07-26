import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDelegateArtifactTools: vi.fn(() => []),
  createContinueDelegateTool: vi.fn(() => ({ name: "continue_delegate" })),
}));

vi.mock("./tools/delegate-artifacts-tool.js", () => ({
  createDelegateArtifactTools: mocks.createDelegateArtifactTools,
}));

vi.mock("./tools/continue-delegate-tool.js", () => ({
  createContinueDelegateTool: mocks.createContinueDelegateTool,
}));

import { createOpenClawContinuationTools } from "./openclaw-tools.continuation.js";

describe("createOpenClawContinuationTools live session identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the live run session for artifact authorization and delegate dispatch", () => {
    createOpenClawContinuationTools({
      config: { agents: { defaults: { continuation: { enabled: true } } } },
      agentSessionKey: "agent:main:sandbox-policy",
      runSessionKey: "agent:main:live-session",
      sessionId: "session-1",
      runId: "run-1",
    });

    expect(mocks.createDelegateArtifactTools).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:main:live-session",
        sessionId: "session-1",
        runId: "run-1",
      }),
    );
    expect(mocks.createContinueDelegateTool).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:live-session",
    });
  });

  it("falls back to the policy session when no separate run session exists", () => {
    createOpenClawContinuationTools({
      config: { agents: { defaults: { continuation: { enabled: true } } } },
      agentSessionKey: "agent:main:session",
    });

    expect(mocks.createDelegateArtifactTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionKey: "agent:main:session" }),
    );
    expect(mocks.createContinueDelegateTool).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:session",
    });
  });
});
