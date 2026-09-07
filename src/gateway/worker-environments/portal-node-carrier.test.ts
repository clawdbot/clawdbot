import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_PORTAL_STREAM_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_WORKER_PORTAL_STREAM_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createWorkerNodePortalCarrier } from "./portal-node-carrier.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

function deferredPortalValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

function portalNodeProof(nodeId: string): NodeWorkerSupervisorNodeProof {
  return {
    nodeId,
    connId: "conn-1",
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: { total: 1, available: 0 },
      portalStream: NODE_WORKER_PORTAL_STREAM_VERSION,
    },
    commands: [],
  };
}

function fakePortalBroker() {
  const attachments: Array<ReturnType<typeof deferredPortalValue<{ stream: PassThrough }>>> = [];
  const streams: PassThrough[] = [];
  const broker = {
    mintPortal: vi.fn(() => {
      const attached = deferredPortalValue<{ stream: PassThrough }>();
      attachments.push(attached);
      return {
        ticket: "a".repeat(48),
        attachPath: `/node-portal/attach?ticket=${"a".repeat(48)}`,
        expiresAtMs: support.testState.nowMs + 60_000,
        attached: attached.promise,
        cancel: () => attached.reject(new Error("ticket cancelled")),
      };
    }),
  } as unknown as NodeDesktopStreamBroker;
  return {
    broker,
    attachNext() {
      const attached = attachments.shift();
      if (!attached) {
        throw new Error("expected pending portal attach");
      }
      const stream = new PassThrough();
      streams.push(stream);
      attached.resolve({ stream });
      return stream;
    },
    streams,
  };
}

function pendingPortalTransport(params: {
  proof: NodeWorkerSupervisorNodeProof;
  isProofCurrent: () => boolean;
}) {
  type InvokeResult = Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>;
  const completions: Array<(result: InvokeResult) => void> = [];
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(
    async (request) =>
      await new Promise((resolve) => {
        completions.push(resolve);
        const abort = () =>
          resolve({ ok: false, error: { code: "ABORTED", message: "invoke aborted" } });
        if (request.signal?.aborted) {
          abort();
        } else {
          request.signal?.addEventListener("abort", abort, { once: true });
        }
      }),
  );
  const transport: NodeWorkerSupervisorTransport = {
    listCurrentNodes: async () => [params.proof],
    hasCurrentRunner: (nodeId) => nodeId === params.proof.nodeId && params.isProofCurrent(),
    isCurrent: () => params.isProofCurrent(),
    invoke,
  };
  return {
    invoke,
    transport,
    dropNext() {
      const complete = completions.shift();
      if (!complete) {
        throw new Error("expected active portal invocation");
      }
      complete({ ok: false, error: { code: "DISCONNECTED", message: "node disconnected" } });
    },
  };
}

describe("worker node portal carrier", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("advertises only current node placements with the versioned portal stream capability", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-portal-capability");
    let current: WorkerEnvironmentRecord | undefined = record;
    let proofCurrent = true;
    const proof = portalNodeProof(record.nodeDeviceId!);
    const transport = pendingPortalTransport({ proof, isProofCurrent: () => proofCurrent });
    const carrier = createWorkerNodePortalCarrier({ store: { get: () => current } });

    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(false);
    carrier.bindRuntime({
      transport: transport.transport,
      streamBroker: fakePortalBroker().broker,
    });
    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(true);
    await expect(carrier.supports(record.environmentId, record.ownerEpoch + 1)).resolves.toBe(
      false,
    );

    proof.workerHost.portalStream = undefined;
    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(false);
    await expect(
      carrier.open({
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        remotePort: 4321,
      }),
    ).rejects.toThrow("sessions.move");
    proof.workerHost.portalStream = NODE_WORKER_PORTAL_STREAM_VERSION;
    proofCurrent = false;
    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(false);
    current = undefined;
    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(false);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("opens one ticketed node duplex per portal connection and closes its owned streams", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-portal-streams");
    const proof = portalNodeProof(record.nodeDeviceId!);
    const transport = pendingPortalTransport({ proof, isProofCurrent: () => true });
    const streamed = fakePortalBroker();
    const carrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });

    const portal = await carrier.open({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      remotePort: 4321,
    });
    expect(transport.invoke).not.toHaveBeenCalled();

    const firstConnection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    const firstStream = streamed.attachNext();
    await expect(firstConnection).resolves.toBe(firstStream);

    const secondConnection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledTimes(2));
    const secondStream = streamed.attachNext();
    await expect(secondConnection).resolves.toBe(secondStream);
    expect(transport.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: NODE_WORKER_PORTAL_STREAM_COMMAND,
        params: {
          ticket: "a".repeat(48),
          attachPath: `/node-portal/attach?ticket=${"a".repeat(48)}`,
          port: 4321,
        },
        timeoutMs: 0,
      }),
    );

    await portal.close();
    expect(firstStream.destroyed).toBe(true);
    expect(secondStream.destroyed).toBe(true);
    await expect(portal.connect()).rejects.toThrow("sessions.move");
  });

  it.each([
    ["lease", (record: WorkerEnvironmentRecord) => ({ ...record, leaseId: "lease:replacement" })],
    [
      "node",
      (record: WorkerEnvironmentRecord) => ({ ...record, nodeDeviceId: "node:replacement" }),
    ],
    [
      "epoch",
      (record: WorkerEnvironmentRecord) => ({ ...record, ownerEpoch: record.ownerEpoch + 1 }),
    ],
    ["state", (record: WorkerEnvironmentRecord) => ({ ...record, state: "draining" as const })],
    [
      "destroy intent",
      (record: WorkerEnvironmentRecord) => ({ ...record, destroyRequestedAtMs: 2_000 }),
    ],
  ] as const)("rejects the attached stream when its durable %s changes", async (_name, mutate) => {
    const record = support.seedReadyNodeDesktop(`worker-node-portal-stale-${_name}`);
    let current: WorkerEnvironmentRecord | undefined = record;
    const transport = pendingPortalTransport({
      proof: portalNodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    const streamed = fakePortalBroker();
    const carrier = createWorkerNodePortalCarrier({ store: { get: () => current } });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    const portal = await carrier.open({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      remotePort: 4321,
    });

    const connection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    current = mutate(record) as WorkerEnvironmentRecord;
    const stream = streamed.attachNext();

    await expect(connection).rejects.toThrow("owner changed before attachment");
    expect(stream.destroyed).toBe(true);
    await portal.close();
  });

  it("destroys a disconnected node stream while retaining the portal for a new connection", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-portal-reconnect");
    const transport = pendingPortalTransport({
      proof: portalNodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    const streamed = fakePortalBroker();
    const carrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    const portal = await carrier.open({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      remotePort: 4321,
    });

    const firstConnection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    const firstStream = streamed.attachNext();
    await firstConnection;
    transport.dropNext();
    await support.waitForFast(() => expect(firstStream.destroyed).toBe(true));

    const recoveredConnection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledTimes(2));
    const recoveredStream = streamed.attachNext();
    await expect(recoveredConnection).resolves.toBe(recoveredStream);

    await carrier.stop(record.environmentId, record.ownerEpoch);
    expect(recoveredStream.destroyed).toBe(true);
  });

  it("aborts an owner that is stopped while node discovery is still pending", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-portal-pending-discovery");
    const pendingNodes = deferredPortalValue<readonly NodeWorkerSupervisorNodeProof[]>();
    const transport = pendingPortalTransport({
      proof: portalNodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    transport.transport.listCurrentNodes = () => pendingNodes.promise;
    const carrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    carrier.bindRuntime({
      transport: transport.transport,
      streamBroker: fakePortalBroker().broker,
    });

    const opening = carrier.open({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      remotePort: 4321,
    });
    await carrier.stop(record.environmentId, record.ownerEpoch);

    await expect(opening).rejects.toThrow("owner stopped");
    expect(transport.invoke).not.toHaveBeenCalled();
  });
});
