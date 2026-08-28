import { describe, expect, it } from "vitest";
import { testWorkerDescriptor } from "../node-host/node-worker-supervisor.test-support.js";
import {
  NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
  parseNodeWorkerConnectionFailureMessage,
  parseNodeWorkerEnvironmentStopInput,
  parseNodeWorkerLaunchInput,
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

describe("node worker supervisor launch request", () => {
  it.each([undefined, 2])(
    "rejects a Gateway without the negotiated environment lifetime marker %s",
    (environmentSession) => {
      const descriptor = testWorkerDescriptor("/tmp/worker", "success", "turn-1");
      expect(() =>
        parseNodeWorkerLaunchInput(
          JSON.stringify({
            environmentSession,
            launchId: "turn-1",
            gatewayNamespace: "gateway-1",
            expectedBundleHash: descriptor.admission.handshake.bundleHash,
            placementGeneration: 4,
            descriptor,
          }),
        ),
      ).toThrow("INVALID_REQUEST");
    },
  );

  it("rejects mismatched launch and turn ids", () => {
    const descriptor = testWorkerDescriptor("/tmp/worker", "success", "turn-1");

    expect(() =>
      parseNodeWorkerLaunchInput(
        JSON.stringify({
          environmentSession: 1,
          launchId: "other-launch",
          gatewayNamespace: "gateway-1",
          expectedBundleHash: descriptor.admission.handshake.bundleHash,
          placementGeneration: 4,
          descriptor,
        }),
      ),
    ).toThrow("launchId must match descriptor assignment turnId");
  });
});

describe("node worker environment stop request", () => {
  const scope = {
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    ownerEpoch: 3,
  };

  it("preserves the exact environment owner independently of its completed turn", () => {
    expect(parseNodeWorkerEnvironmentStopInput(JSON.stringify(scope))).toEqual(scope);
  });

  it.each([
    { ...scope, ownerEpoch: undefined },
    { ...scope, ownerEpoch: -1 },
    { ...scope, sessionId: "" },
    { ...scope, gatewayNamespace: "../gateway" },
    { ...scope, launchId: "turn-1" },
    { ...scope, environmentId: "x".repeat(4096) },
  ])("rejects an incomplete or unbounded environment owner: %j", (input) => {
    expect(() => parseNodeWorkerEnvironmentStopInput(JSON.stringify(input))).toThrow(
      "INVALID_REQUEST",
    );
  });
});

describe("node worker supervisor wire receipt", () => {
  it("accepts only bounded worker connection diagnostics", () => {
    expect(
      parseNodeWorkerConnectionFailureMessage({
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: "certificate rejected",
      }),
    ).toEqual({
      type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
      cause: "certificate rejected",
    });
    expect(
      parseNodeWorkerConnectionFailureMessage({
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: null,
      }),
    ).toEqual({ type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE, cause: null });
    expect(
      parseNodeWorkerConnectionFailureMessage({
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: "x".repeat(64 * 1024 + 1),
      }),
    ).toBeNull();
  });

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
