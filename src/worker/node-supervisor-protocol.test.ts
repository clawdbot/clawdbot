import { describe, expect, it } from "vitest";
import {
  parseNodeWorkerSupervisorReceipt,
  type NodeWorkerSupervisorIdentity,
} from "./node-supervisor-protocol.js";

const RESULT_JSON_MAX_BYTES = 64 * 1024;
const ERROR_TEXT_MAX_BYTES = 4 * 1024;

const identity: NodeWorkerSupervisorIdentity = {
  launchId: "launch-1",
  planHash: "a".repeat(64),
  environmentId: "environment-1",
  sessionId: "session-1",
  ownerEpoch: 3,
  placementGeneration: 4,
  runId: "run-1",
};

describe("node worker supervisor wire receipt", () => {
  it.each([
    { ...identity, state: "pending" },
    { ...identity, state: "running" },
    {
      ...identity,
      state: "completed",
      resultJson: JSON.stringify({ status: "completed", transcriptNextSeq: 2 }),
    },
    { ...identity, state: "failed", errorText: "worker exited before completion" },
    { ...identity, state: "interrupted", errorText: "node host stopped" },
    { ...identity, state: "cancelled", errorText: "node worker launch cancelled" },
  ])("round-trips the closed $state receipt", (receipt) => {
    expect(parseNodeWorkerSupervisorReceipt(receipt)).toEqual(receipt);
  });

  it.each([
    { name: "extra field", receipt: { ...identity, state: "running", workerPid: 123 } },
    { name: "missing plan hash", receipt: { ...identity, planHash: undefined, state: "running" } },
    { name: "completed without output", receipt: { ...identity, state: "completed" } },
    {
      name: "completed with malformed output",
      receipt: { ...identity, state: "completed", resultJson: "{" },
    },
    {
      name: "oversized completed output",
      receipt: {
        ...identity,
        state: "completed",
        resultJson: JSON.stringify({ text: "x".repeat(RESULT_JSON_MAX_BYTES) }),
      },
    },
    { name: "failed without error", receipt: { ...identity, state: "failed" } },
    {
      name: "multiline error",
      receipt: { ...identity, state: "failed", errorText: "first\nsecond" },
    },
    {
      name: "oversized error",
      receipt: {
        ...identity,
        state: "failed",
        errorText: "x".repeat(ERROR_TEXT_MAX_BYTES + 1),
      },
    },
  ])("rejects $name", ({ receipt }) => {
    expect(parseNodeWorkerSupervisorReceipt(receipt)).toBeNull();
  });

  it("rejects non-object values without throwing", () => {
    expect(parseNodeWorkerSupervisorReceipt("{")).toBeNull();
    expect(parseNodeWorkerSupervisorReceipt(null)).toBeNull();
  });
});
