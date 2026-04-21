import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentInternalEvent } from "../internal-events.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";

type ForwardingCase = {
  runId: string;
  params: Partial<RunEmbeddedPiAgentParams>;
  expected: Record<string, unknown>;
};

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
const internalEvents: AgentInternalEvent[] = [];
const forwardingCase = {
  runId: "forward-attempt-params",
  params: {
    toolsAllow: ["exec", "read"],
    bootstrapContextMode: "lightweight",
    bootstrapContextRunKind: "cron",
    disableMessageTool: true,
    forceMessageTool: true,
    requireExplicitMessageTarget: true,
    internalEvents,
  },
  expected: {
    toolsAllow: ["exec", "read"],
    bootstrapContextMode: "lightweight",
    bootstrapContextRunKind: "cron",
    disableMessageTool: true,
    forceMessageTool: true,
    requireExplicitMessageTarget: true,
    internalEvents,
  },
} satisfies ForwardingCase;

describe("runEmbeddedPiAgent forwards optional params to runEmbeddedAttempt", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("forwards optional attempt params in one attempt call", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      ...forwardingCase.params,
      runId: forwardingCase.runId,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining(forwardingCase.expected),
    );
  });
});
