import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
} from "../infra/node-commands.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { handleInvoke } from "./invoke.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { NodeWorkerSupervisorControl } from "./node-worker-supervisor-contract.js";
import {
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function launchInput() {
  const fixture = writeNodeWorkerFixture(tempDirs.make("node-worker-invoke-"));
  return testWorkerLaunchInput(fixture.workspaceDir, "launch-1", "wait");
}

function fullReceipt(input = launchInput()): NodeWorkerLaunchReceipt {
  return {
    launchId: input.launchId,
    planHash: "a".repeat(64),
    gatewayNamespace: input.gatewayNamespace,
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    ownerEpoch: input.descriptor.admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    runId: input.descriptor.assignment.runId,
    state: "running",
    supervisor: { pid: 100, startTime: 1 },
    worker: { pid: 101, startTime: 2 },
    resultJson: null,
    errorText: null,
    completedAtMs: null,
    createdAtMs: 10,
    updatedAtMs: 11,
  };
}

function cancelInput(receipt: NodeWorkerLaunchReceipt) {
  return {
    launchId: receipt.launchId,
    planHash: receipt.planHash,
    environmentId: receipt.environmentId,
    sessionId: receipt.sessionId,
    ownerEpoch: receipt.ownerEpoch,
    placementGeneration: receipt.placementGeneration,
    runId: receipt.runId,
  };
}

function supervisorWith(receipt: NodeWorkerLaunchReceipt): NodeWorkerSupervisorControl {
  return {
    launch: vi.fn(async () => receipt),
    status: vi.fn(async () => receipt),
    cancel: vi.fn(async () => receipt),
  };
}

type SupervisorMocks = {
  launch: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

function supervisorMocks(supervisor: NodeWorkerSupervisorControl): SupervisorMocks {
  return supervisor as unknown as SupervisorMocks;
}

async function invokePrivate(params: {
  command: string;
  paramsJSON?: string;
  supervisor: NodeWorkerSupervisorControl;
}) {
  const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
  await handleInvoke(
    {
      id: "invoke-1",
      nodeId: "node-1",
      command: params.command,
      paramsJSON: params.paramsJSON,
    },
    { request } as unknown as GatewayClient,
    { current: async () => [] },
    undefined,
    { workerSupervisor: params.supervisor },
  );
  return {
    request,
    result: request.mock.calls.find(([method]) => method === "node.invoke.result")?.[1] as
      | { ok?: boolean; payloadJSON?: string; error?: { code?: string; message?: string } }
      | undefined,
  };
}

describe("node-host worker supervisor commands", () => {
  it.each([
    { command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND, method: "launch" as const },
    { command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND, method: "status" as const },
    { command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND, method: "cancel" as const },
  ])("dispatches $command before a colliding plugin command", async ({ command, method }) => {
    const input = launchInput();
    const receipt = fullReceipt(input);
    const supervisor = supervisorWith(receipt);
    const pluginHandle = vi.fn(async () => '{"plugin":true}');
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "malicious",
        pluginName: "Malicious",
        command: { command, handle: pluginHandle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const { result } = await invokePrivate({
      command,
      paramsJSON: JSON.stringify(
        method === "launch"
          ? input
          : method === "cancel"
            ? cancelInput(receipt)
            : { launchId: input.launchId },
      ),
      supervisor,
    });

    const mocks = supervisorMocks(supervisor);
    expect(mocks[method].mock.calls).toHaveLength(1);
    if (method === "cancel") {
      expect(mocks.cancel.mock.calls[0]?.[0]).toEqual(cancelInput(receipt));
    }
    expect(pluginHandle).not.toHaveBeenCalled();
    expect(result?.ok).toBe(true);
    const payload = JSON.parse(result?.payloadJSON ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      launchId: input.launchId,
      state: "running",
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
    });
    expect(payload).not.toHaveProperty("supervisor");
    expect(payload).not.toHaveProperty("worker");
    expect(payload).not.toHaveProperty("gatewayNamespace");
    expect(payload).not.toHaveProperty("descriptor");
    expect(payload).not.toHaveProperty("errorText");
  });

  it("returns completed worker output without internal process fields", async () => {
    const input = launchInput();
    const resultJson = JSON.stringify({
      status: "completed",
      transcriptLeafId: "leaf-1",
      transcriptNextSeq: 2,
    });
    const receipt: NodeWorkerLaunchReceipt = {
      ...fullReceipt(input),
      state: "completed",
      resultJson,
      completedAtMs: 12,
    };

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: input.launchId }),
      supervisor: supervisorWith(receipt),
    });

    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual({
      launchId: input.launchId,
      planHash: receipt.planHash,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
      state: "completed",
      resultJson,
    });
    const payload = JSON.parse(result?.payloadJSON ?? "{}") as Record<string, unknown>;
    expect(payload).not.toHaveProperty("supervisor");
    expect(payload).not.toHaveProperty("worker");
    expect(payload).not.toHaveProperty("gatewayNamespace");
    expect(payload).not.toHaveProperty("descriptor");
    expect(payload).not.toHaveProperty("errorText");
  });

  it("returns failed worker diagnostics without completed output", async () => {
    const input = launchInput();
    const receipt: NodeWorkerLaunchReceipt = {
      ...fullReceipt(input),
      state: "failed",
      worker: null,
      errorText: "worker exited before completion",
      completedAtMs: 12,
    };

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: input.launchId }),
      supervisor: supervisorWith(receipt),
    });

    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual({
      launchId: input.launchId,
      planHash: receipt.planHash,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
      state: "failed",
      errorText: receipt.errorText,
    });
  });

  it.each([
    { name: "malformed JSON", command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND, raw: "{" },
    {
      name: "extra status field",
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      raw: JSON.stringify({ launchId: "launch-1", extra: true }),
    },
    {
      name: "incomplete cancel identity",
      command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
      raw: JSON.stringify({ launchId: "x".repeat(257) }),
    },
    {
      name: "extra cancel identity field",
      command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
      raw: JSON.stringify({ ...cancelInput(fullReceipt()), extra: true }),
    },
    {
      name: "extra launch field",
      command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      raw: JSON.stringify({ ...launchInput(), extra: true }),
    },
  ])("rejects $name without reaching the supervisor", async ({ command, raw }) => {
    const supervisor = supervisorWith(fullReceipt());

    const { result } = await invokePrivate({ command, paramsJSON: raw, supervisor });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const mocks = supervisorMocks(supervisor);
    expect(mocks.launch.mock.calls).toHaveLength(0);
    expect(mocks.status.mock.calls).toHaveLength(0);
    expect(mocks.cancel.mock.calls).toHaveLength(0);
  });

  it("fails closed when a durable terminal receipt is inconsistent", async () => {
    const input = launchInput();
    const receipt: NodeWorkerLaunchReceipt = {
      ...fullReceipt(input),
      state: "completed",
      resultJson: null,
      completedAtMs: 12,
    };

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: input.launchId }),
      supervisor: supervisorWith(receipt),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "node worker supervisor command failed" },
    });
  });

  it("returns a bounded generic error without leaking supervisor details", async () => {
    const leaked = `/private/path/${"secret".repeat(2_000)}`;
    const supervisor = supervisorWith(fullReceipt());
    supervisorMocks(supervisor).status.mockRejectedValueOnce(new Error(leaked));

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: "launch-1" }),
      supervisor,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    const message = result?.error?.message ?? "";
    expect(message).not.toContain("private/path");
    expect(message.length).toBeLessThan(256);
  });
});
