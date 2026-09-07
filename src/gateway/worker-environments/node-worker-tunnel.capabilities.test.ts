import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { WORKER_SKILL_RESOURCE_COMMAND } from "../../worker/skill-resource-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  environment,
  startRequest,
  transport,
  withWorkspaceDrain,
  workspaceCommandPayload,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { REMOTE_WORKSPACE_QUIESCE_JS } from "./workspace-quiescence-scripts.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("node worker workspace capability", () => {
  it("rejects normal workspace commands after a node downgrade but still resumes and stops its owner", async () => {
    const localPath = tempDirs.make("node-workspace-capability-loss-");
    const actual = await readActualWorkspaceManifest({ root: localPath, baseCommit: null });
    const rawManifest = serializeWorkerWorkspaceManifest(actual.manifest);
    const nodeTransport = transport();
    let node = (await nodeTransport.listCurrentNodes())[0]!;
    nodeTransport.listCurrentNodes = async () => [node];
    const nonce = "a".repeat(32);
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async ({ command, params }) => {
      if (command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        return { ok: true, payloadJSON: "null" };
      }
      const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(params));
      const stdout = input.transfer
        ? actual.manifestRef
        : input.argv[2] === REMOTE_WORKSPACE_QUIESCE_JS
          ? `quiesced ${nonce}`
          : "";
      return { ok: true, payloadJSON: workspaceCommandPayload("/node/workspace", { stdout }) };
    });
    nodeTransport.invoke = withWorkspaceDrain(invoke);
    const transfer = {
      ...workspaceTransfer(),
      prepareSync: vi.fn(async () => ({
        token: "token",
        snapshot: { ...actual, rawManifest, root: localPath },
      })),
      revoke: vi.fn(),
      closeAll: vi.fn(async () => {}),
    };
    const record = environment();
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start(startRequest());
    await handle.syncWorkspace({
      source: { kind: "local", path: localPath },
      sessionId: "session-1",
      generation: 1,
    });
    const resources = {
      argv: [WORKER_SKILL_RESOURCE_COMMAND],
      transportRetry: "never" as const,
      assertCurrent: () => {},
      skillResources: {
        workspaceDir: "/node/workspace",
        generation: 2,
        operation: { operation: "init" as const },
      },
    };
    const beforeResources = invoke.mock.calls.length;
    await expect(handle.runWorkspaceCommand(resources)).rejects.toThrow("openclaw update");
    expect(invoke).toHaveBeenCalledTimes(beforeResources);
    node.workerHost.workspaceSkillResources = 1;
    await handle.runWorkspaceCommand(resources);
    expect(invoke.mock.calls.at(-1)?.[0].params).toMatchObject({
      argv: [WORKER_SKILL_RESOURCE_COMMAND],
      skillResources: { operation: "init" },
    });
    for (const changed of [{ workspaceDir: "/other/workspace" }, { generation: 3 }]) {
      await expect(
        handle.runWorkspaceCommand({
          ...resources,
          skillResources: { ...resources.skillResources, ...changed },
        }),
      ).rejects.toThrow("workspace owner");
    }
    await expect(
      handle.runWorkspaceCommand({ ...resources, transportRetry: "idempotent" }),
    ).rejects.toThrow("workspace owner");
    expect(invoke).toHaveBeenCalledTimes(beforeResources + 1);
    const quiescence = await handle.quiesceWorkspace("/node/workspace");
    node = {
      ...node,
      connId: "conn-reconnected",
      workerHost: { ...node.workerHost, workspaceManifest: undefined },
    };
    const before = invoke.mock.calls.length;
    await expect(
      handle.runWorkspaceCommand({
        argv: ["node", "-e", "process.exit(0)"],
        transportRetry: "idempotent",
      }),
    ).rejects.toThrow("openclaw update");
    expect(invoke).toHaveBeenCalledTimes(before);
    await quiescence.resume();
    expect(invoke).toHaveBeenCalledTimes(before + 1);
    await manager.stopAll();
    expect(invoke.mock.calls.at(-1)?.[0].command).toBe(NODE_WORKER_ENVIRONMENT_STOP_COMMAND);
  });

  it("requires an upgraded node before initializing its workspace, while retaining cleanup access", async () => {
    const nodeTransport = transport();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
      ok: true,
      payloadJSON: "null",
    }));
    nodeTransport.invoke = withWorkspaceDrain(invoke);
    const nodes = await nodeTransport.listCurrentNodes();
    const node = nodes[0]!;
    delete node.workerHost.workspaceManifest;
    nodeTransport.listCurrentNodes = async () => [node];
    const transfer = { ...workspaceTransfer(), closeAll: vi.fn(async () => {}) };
    const record = environment();
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    await expect(manager.start(startRequest())).rejects.toThrow("openclaw update");
    expect(invoke).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "worker.workspace.exec.v1" }),
    );
    await manager.stopAll();
    expect(transfer.close).toHaveBeenCalled();
  });
});
