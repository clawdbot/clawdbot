import { expect } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

export const REQUESTER = "agent:main:main";
export const requesterSettleKey = (suffix: string) =>
  `announce:requester-settle:main:${REQUESTER}:${suffix}`;

type SettledChildOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & {
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
  execution?: SubagentRunRecord["execution"];
};

export function makeSettledChild(overrides: SettledChildOverrides): SubagentRunRecord {
  const runId = overrides.runId ?? "run-child";
  const { startedAt = 2_000, endedAt = 3_000, outcome, execution, ...recordOverrides } = overrides;
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: execution ?? { status: "terminal", startedAt, endedAt, outcome },
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
    ...recordOverrides,
  };
}

export function makeYieldedChild(
  params: {
    execution?: SubagentRunRecord["execution"];
    afterRequesterYield?: boolean;
  } = {},
): SubagentRunRecord {
  return makeSettledChild({
    runId: "run-b",
    ...(params.execution ? { execution: params.execution } : {}),
    delivery: { status: "delivered" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      batchRunIds: ["run-b"],
      requesterYieldBatch: true,
      ...(params.afterRequesterYield ? { afterRequesterYield: true } : {}),
      rearmGeneration: 1,
    },
  });
}

export function expectContinuationFirstWake(call: Record<string, unknown>): void {
  expect(call.requireVisibleReply).toBeUndefined();
  expect(call.requireContinuationProgress).toBe(true);
  const message = String(call.triggerMessage);
  expect(message).toContain("deciding whether the original task is done");
  expect(message).toContain(
    "If additional action is required, continue any remaining in-scope work",
  );
  expect(message).not.toContain("send your consolidated final answer to the user now");
  expect(message).not.toContain("NO_REPLY");
}
