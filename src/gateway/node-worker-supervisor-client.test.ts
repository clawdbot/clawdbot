import { describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
} from "../infra/node-commands.js";
import {
  nodeWorkerLaunchIdentity,
  type NodeWorkerSupervisorReceipt,
} from "../node-host/node-worker-supervisor-contract.js";
import {
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "../node-host/node-worker-supervisor.test-support.js";
import { NodeRegistry } from "./node-registry.js";
import { createNodeWorkerSupervisorClient } from "./node-worker-supervisor-client.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeGatewayClient(
  params: {
    connId?: string;
    nodeId?: string;
    clientId?: string;
    clientMode?: string;
    onSend?: (frame: string) => void;
  } = {},
): GatewayWsClient {
  const connId = params.connId ?? "conn-1";
  const nodeId = params.nodeId ?? "node-1";
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((frame: unknown) => {
        if (typeof frame === "string") {
          params.onSend?.(frame);
        }
      }),
      close: vi.fn(),
    } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: params.clientId ?? GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "linux",
        mode: params.clientMode ?? GATEWAY_CLIENT_MODES.NODE,
      },
      device: {
        id: nodeId,
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
      caps: [],
      commands: [],
    } as unknown as GatewayWsClient["connect"],
  };
}

function registerNodeHost(
  registry: NodeRegistry,
  params: Parameters<typeof makeGatewayClient>[0] = {},
) {
  const client = makeGatewayClient(params);
  registry.register(client, {
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
  });
  return client;
}

function makeLaunchInput() {
  const fixture = writeNodeWorkerFixture(tempDirs.make("node-worker-client-"));
  return testWorkerLaunchInput(fixture.workspaceDir, "launch-1", "wait");
}

function runningReceipt(input = makeLaunchInput()): NodeWorkerSupervisorReceipt {
  return {
    ...nodeWorkerLaunchIdentity(input),
    state: "running",
  };
}

describe("gateway node worker supervisor client", () => {
  it("invokes an unadvertised private launch command on the exact node-host session", async () => {
    const registry = new NodeRegistry();
    const input = makeLaunchInput();
    const expected = runningReceipt(input);
    registerNodeHost(registry, {
      onSend: (raw) => {
        const request = JSON.parse(raw) as {
          event?: string;
          payload?: { id?: string; command?: string };
        };
        expect(request.event).toBe("node.invoke.request");
        expect(request.payload?.command).toBe(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
        queueMicrotask(() => {
          registry.handleInvokeResult({
            id: request.payload?.id ?? "",
            nodeId: "node-1",
            connId: "conn-1",
            ok: true,
            payloadJSON: JSON.stringify(expected),
          });
        });
      },
    });

    const result = await createNodeWorkerSupervisorClient(registry).launch({
      nodeId: "node-1",
      input,
      isDispatchAuthorized: () => true,
    });

    expect(result).toEqual({ ok: true, dispatch: "sent", receipt: expected });
  });

  it.each([
    { name: "wrong client id", clientId: GATEWAY_CLIENT_IDS.MACOS_APP, clientMode: "node" },
    { name: "wrong client mode", clientId: GATEWAY_CLIENT_IDS.NODE_HOST, clientMode: "backend" },
  ])("rejects $name without dispatch", async ({ clientId, clientMode }) => {
    const registry = new NodeRegistry();
    const client = registerNodeHost(registry, { clientId, clientMode });

    const result = await createNodeWorkerSupervisorClient(registry).launch({
      nodeId: "node-1",
      input: makeLaunchInput(),
      isDispatchAuthorized: () => true,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatch: "not-sent",
      error: { code: "INVALID_NODE_HOST" },
    });
    const socket = client.socket as unknown as { send: ReturnType<typeof vi.fn> };
    expect(socket.send.mock.calls).toHaveLength(0);
  });

  it.each(["connection", "pairing", "authority"] as const)(
    "rejects stale %s authority before transport send",
    async (stale) => {
      const registry = new NodeRegistry();
      const original = registerNodeHost(registry);
      const invoke = registry.invoke.bind(registry);
      let authorized = true;
      if (stale === "connection") {
        vi.spyOn(registry, "invoke").mockImplementationOnce(async (params) => {
          registerNodeHost(registry, { connId: "conn-2" });
          return await invoke(params);
        });
      } else if (stale === "pairing") {
        vi.spyOn(registry, "invoke").mockImplementationOnce(async (params) => {
          registry.updateSurface(
            "node-1",
            { commands: [] },
            {
              expectedConnId: "conn-1",
              expectedPairingIdentity: "identity-1",
              expectedPairingGeneration: "generation-1",
              nextPairingGeneration: "generation-2",
            },
          );
          return await invoke(params);
        });
      } else {
        vi.spyOn(registry, "invoke").mockImplementationOnce(async (params) => {
          authorized = false;
          return await invoke(params);
        });
      }

      const result = await createNodeWorkerSupervisorClient(registry).launch({
        nodeId: "node-1",
        input: makeLaunchInput(),
        isDispatchAuthorized: () => authorized,
      });

      expect(result).toMatchObject({ ok: false, dispatch: "not-sent" });
      const socket = original.socket as unknown as { send: ReturnType<typeof vi.fn> };
      expect(socket.send.mock.calls).toHaveLength(0);
    },
  );

  it("marks disconnect after a successful send as an ambiguous dispatched failure", async () => {
    const registry = new NodeRegistry();
    registerNodeHost(registry, {
      onSend: () => {
        registry.unregister("conn-1");
      },
    });

    const result = await createNodeWorkerSupervisorClient(registry).launch({
      nodeId: "node-1",
      input: makeLaunchInput(),
      isDispatchAuthorized: () => true,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatch: "sent",
      error: { code: "DISCONNECTED", ambiguous: true },
    });
  });

  it("rejects success without dispatch provenance as not sent", async () => {
    const registry = new NodeRegistry();
    registerNodeHost(registry);
    const input = makeLaunchInput();
    vi.spyOn(registry, "invoke").mockResolvedValueOnce({
      ok: true,
      payloadJSON: JSON.stringify(runningReceipt(input)),
    });

    const result = await createNodeWorkerSupervisorClient(registry).launch({
      nodeId: "node-1",
      input,
      isDispatchAuthorized: () => true,
    });

    expect(result).toEqual({
      ok: false,
      dispatch: "not-sent",
      error: {
        code: "INVALID_REPLY",
        message: "node worker supervisor returned success without dispatch provenance",
        ambiguous: false,
      },
    });
  });

  it.each([
    { name: "malformed JSON", payload: "{" },
    { name: "oversized JSON", payload: " ".repeat(1024 * 1024) },
    {
      name: "extra fields",
      payload: JSON.stringify({ ...runningReceipt(), leakedPid: 123 }),
    },
  ])("rejects $name replies", async ({ payload }) => {
    const registry = new NodeRegistry();
    registerNodeHost(registry);
    vi.spyOn(registry, "invoke").mockImplementationOnce(async (params) => {
      params.onDispatchReady?.("invoke-1");
      return { ok: true, payloadJSON: payload };
    });

    const result = await createNodeWorkerSupervisorClient(registry).launch({
      nodeId: "node-1",
      input: makeLaunchInput(),
      isDispatchAuthorized: () => true,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatch: "sent",
      error: { code: "INVALID_REPLY" },
    });
  });

  it.each([
    ["launchId", "launch-other"],
    ["planHash", "b".repeat(64)],
    ["environmentId", "environment-other"],
    ["sessionId", "session-other"],
    ["ownerEpoch", 9],
    ["placementGeneration", 10],
    ["runId", "run-other"],
  ] as const)("rejects a reply with mismatched %s", async (field, value) => {
    const registry = new NodeRegistry();
    registerNodeHost(registry);
    const input = makeLaunchInput();
    const expected = nodeWorkerLaunchIdentity(input);
    vi.spyOn(registry, "invoke").mockImplementationOnce(async (params) => {
      expect(params.command).toBe(NODE_WORKER_SUPERVISOR_STATUS_COMMAND);
      params.onDispatchReady?.("invoke-1");
      return {
        ok: true,
        payloadJSON: JSON.stringify({ ...runningReceipt(input), [field]: value }),
      };
    });

    const result = await createNodeWorkerSupervisorClient(registry).status({
      nodeId: "node-1",
      expected,
      isDispatchAuthorized: () => true,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatch: "sent",
      error: { code: "IDENTITY_MISMATCH" },
    });
  });

  it("does not dispatch cancel when the status identity mismatches", async () => {
    const registry = new NodeRegistry();
    registerNodeHost(registry);
    const input = makeLaunchInput();
    const expected = nodeWorkerLaunchIdentity(input);
    const commands: string[] = [];
    vi.spyOn(registry, "invoke").mockImplementation(async (params) => {
      commands.push(params.command);
      expect(params.command).toBe(NODE_WORKER_SUPERVISOR_STATUS_COMMAND);
      expect(params.params).toEqual({ launchId: expected.launchId });
      params.onDispatchReady?.("invoke-status");
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          ...runningReceipt(input),
          environmentId: "environment-other",
          sessionId: "session-other",
          runId: "run-other",
        }),
      };
    });

    const result = await createNodeWorkerSupervisorClient(registry).cancel({
      nodeId: "node-1",
      expected,
      isDispatchAuthorized: () => true,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatch: "sent",
      error: { code: "IDENTITY_MISMATCH", ambiguous: false },
    });
    expect(commands).toEqual([NODE_WORKER_SUPERVISOR_STATUS_COMMAND]);
    expect(commands).not.toContain(NODE_WORKER_SUPERVISOR_CANCEL_COMMAND);
  });
});
