import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  buildTrajectoryRunMetadata: vi.fn(() => ({ trace: "metadata" })),
  createTrajectoryRuntimeRecorder: vi.fn(),
  resolveAttemptTrajectorySessionFile: vi.fn(async () => "/tmp/trajectory.jsonl"),
}));

vi.mock("../../../trajectory/metadata.js", () => ({
  buildTrajectoryRunMetadata: hoisted.buildTrajectoryRunMetadata,
}));
vi.mock("../../../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: hoisted.createTrajectoryRuntimeRecorder,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveAttemptTrajectorySessionFile: hoisted.resolveAttemptTrajectorySessionFile,
}));

import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";

function createInput(disableTrajectory = false) {
  return {
    activeSession: { sessionId: "session-1" },
    attempt: {
      config: {},
      disableTrajectory,
      fastMode: true,
      model: { api: "anthropic-messages" },
      modelId: "model-1",
      provider: "provider-1",
      runId: "run-1",
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:session-1",
      thinkLevel: "medium",
      trigger: "user",
      workspaceDir: "/tmp/workspace",
    },
    clientToolCount: 2,
    effectiveToolCount: 7,
    effectiveWorkspace: "/tmp/workspace",
    localModelLeanEnabled: false,
    sessionAgentId: "main",
  };
}

describe("prepareEmbeddedAttemptTrajectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the recorder and seeds session and trace metadata", async () => {
    const recorder = { recordEvent: vi.fn() };
    hoisted.createTrajectoryRuntimeRecorder.mockReturnValue(recorder);

    const result = await prepareEmbeddedAttemptTrajectory(createInput() as never);

    expect(result).toBe(recorder);
    expect(hoisted.resolveAttemptTrajectorySessionFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
      }),
    );
    expect(hoisted.createTrajectoryRuntimeRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        sessionFile: "/tmp/trajectory.jsonl",
        sessionId: "session-1",
      }),
    );
    expect(recorder.recordEvent).toHaveBeenNthCalledWith(
      1,
      "session.started",
      expect.objectContaining({ toolCount: 7, clientToolCount: 2 }),
    );
    expect(recorder.recordEvent).toHaveBeenNthCalledWith(2, "trace.metadata", {
      trace: "metadata",
    });
    expect(hoisted.buildTrajectoryRunMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ fastMode: true, provider: "provider-1" }),
    );
  });

  it("keeps trajectory path resolution but skips recorder creation when disabled", async () => {
    await expect(prepareEmbeddedAttemptTrajectory(createInput(true) as never)).resolves.toBeNull();

    expect(hoisted.resolveAttemptTrajectorySessionFile).toHaveBeenCalledOnce();
    expect(hoisted.createTrajectoryRuntimeRecorder).not.toHaveBeenCalled();
    expect(hoisted.buildTrajectoryRunMetadata).not.toHaveBeenCalled();
  });
});
