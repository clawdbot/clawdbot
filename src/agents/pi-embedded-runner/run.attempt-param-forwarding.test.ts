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
  name: string;
  runId: string;
  params: Partial<RunEmbeddedPiAgentParams>;
  expected: Record<string, unknown>;
};

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
const internalEvents: AgentInternalEvent[] = [];
const forwardingCases = [
  {
    name: "forwards toolsAllow so the per-job tool allowlist can be honored",
    runId: "forward-toolsAllow",
    params: { toolsAllow: ["exec", "read"] },
    expected: { toolsAllow: ["exec", "read"] },
  },
  {
    name: "forwards bootstrapContextMode so lightContext cron jobs strip workspace bootstrap files",
    runId: "forward-bootstrapContextMode",
    params: { bootstrapContextMode: "lightweight" },
    expected: { bootstrapContextMode: "lightweight" },
  },
  {
    name: "forwards bootstrapContextRunKind so the bootstrap filter knows the caller context",
    runId: "forward-bootstrapContextRunKind",
    params: { bootstrapContextRunKind: "cron" },
    expected: { bootstrapContextRunKind: "cron" },
  },
  {
    name: "forwards disableMessageTool so cron-owned delivery suppresses the messaging tool",
    runId: "forward-disableMessageTool",
    params: { disableMessageTool: true },
    expected: { disableMessageTool: true },
  },
  {
    name: "forwards requireExplicitMessageTarget so non-subagent callers can opt in explicitly",
    runId: "forward-requireExplicitMessageTarget",
    params: { requireExplicitMessageTarget: true },
    expected: { requireExplicitMessageTarget: true },
  },
  {
    name: "forwards internalEvents so the agent command attempt path can deliver internal events",
    runId: "forward-internalEvents",
    params: { internalEvents },
    expected: { internalEvents },
  },
] satisfies ForwardingCase[];

describe("runEmbeddedPiAgent forwards optional params to runEmbeddedAttempt", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it.each(forwardingCases)("$name", async ({ runId, params, expected }) => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      ...params,
      runId,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(expect.objectContaining(expected));
  });
});
