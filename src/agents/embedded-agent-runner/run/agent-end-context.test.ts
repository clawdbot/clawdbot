import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEmbeddedAgentEndContext } from "./agent-end-context.js";

const hoisted = vi.hoisted(() => ({
  isMemoryIsolationCutoverAgent: vi.fn(),
}));

vi.mock("../../../plugins/memory-cutover.js", () => ({
  isMemoryIsolationCutoverAgent: hoisted.isMemoryIsolationCutoverAgent,
}));

function buildContext(agentId: string) {
  return buildEmbeddedAgentEndContext({
    run: {
      runId: "run-1",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
    } as never,
    agentId,
    trace: undefined as never,
    skillWorkshopAvailable: false,
    compacted: false,
  });
}

describe("buildEmbeddedAgentEndContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries the cutover gate to agent_end hooks", () => {
    hoisted.isMemoryIsolationCutoverAgent.mockReturnValue(true);

    expect(buildContext("main")).toMatchObject({
      agentId: "main",
      memoryReadEnforced: true,
    });
  });

  it("does not mark legacy agents as enforced", () => {
    hoisted.isMemoryIsolationCutoverAgent.mockReturnValue(false);

    expect(buildContext("main")).not.toHaveProperty("memoryReadEnforced");
  });
});
