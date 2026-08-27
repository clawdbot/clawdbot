import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
import { createDesktopSessionRegistry } from "../desktop/session-registry.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createWorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

function nodeProof(nodeId: string): NodeWorkerSupervisorNodeProof {
  return {
    nodeId,
    connId: "conn-1",
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
    commands: [],
  };
}

function fakeBroker() {
  type AttachedStream = {
    auth: "vnc-password";
    vncPassword: string;
    stream: PassThrough;
  };
  const attachments: Array<ReturnType<typeof deferred<AttachedStream>>> = [];
  const streams: PassThrough[] = [];
  const broker = {
    mint: vi.fn(() => {
      const attached = deferred<AttachedStream>();
      attachments.push(attached);
      return {
        ticket: "a".repeat(48),
        attachPath: `/node-desktop/attach?ticket=${"a".repeat(48)}`,
        expiresAtMs: support.testState.nowMs + 60_000,
        attached: attached.promise,
        cancel: () => attached.reject(new Error("ticket cancelled")),
      };
    }),
    handleUpgrade: vi.fn(),
  } as unknown as NodeDesktopStreamBroker;
  return {
    broker,
    attachNext() {
      const attached = attachments.shift();
      if (!attached) {
        throw new Error("expected pending desktop attach");
      }
      const stream = new PassThrough();
      streams.push(stream);
      attached.resolve({ auth: "vnc-password", vncPassword: "worker-password", stream });
      return stream;
    },
    streams,
  };
}

function pendingTransport(params: {
  proof: NodeWorkerSupervisorNodeProof;
  isProofCurrent: () => boolean;
}) {
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(
    async (request) =>
      await new Promise((resolve) => {
        const finish = () =>
          resolve({ ok: false, error: { code: "ABORTED", message: "invoke aborted" } });
        if (request.signal?.aborted) {
          finish();
        } else {
          request.signal?.addEventListener("abort", finish, { once: true });
        }
      }),
  );
  const transport: NodeWorkerSupervisorTransport = {
    listCurrentNodes: async () => [params.proof],
    hasCurrentRunner: (nodeId) => nodeId === params.proof.nodeId && params.isProofCurrent(),
    isCurrent: () => params.isProofCurrent(),
    invoke,
  };
  return { invoke, transport };
}

describe("worker node desktop carrier", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.restoreAllMocks());

  it("observes an exact durable node desktop without SSH and preauthenticates it", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-desktop-observe");
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let current: WorkerEnvironmentRecord | undefined = record;
    let proofCurrent = true;
    const proof = nodeProof(record.nodeDeviceId!);
    const transport = pendingTransport({ proof, isProofCurrent: () => proofCurrent });
    const streamed = fakeBroker();
    const registry = createDesktopSessionRegistry({ lingerMs: 1 });
    const carrier = createWorkerNodeDesktopCarrier({
      store: { get: () => current },
      desktopRegistry: registry,
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });

    const observing = carrier.observe({ record, control: false });
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    nowMs = 50_000;
    streamed.attachNext();

    await expect(observing).resolves.toMatchObject({
      transport: "rfb",
      wsPath: expect.stringMatching(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u),
      expiresAtMs: 110_000,
      control: false,
    });
    expect(await observing).not.toHaveProperty("vncPassword");
    expect(transport.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          ticket: "a".repeat(48),
          attachPath: `/node-desktop/attach?ticket=${"a".repeat(48)}`,
          port: 5900,
          passwordFilePath: "/var/lib/crabbox/vnc.password",
        },
        timeoutMs: 0,
      }),
    );

    current = undefined;
    proofCurrent = false;
    await carrier.stop(record.environmentId, record.ownerEpoch);
    expect(streamed.streams[0]?.destroyed).toBe(true);
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
    [
      "desktop descriptor",
      (record: WorkerEnvironmentRecord) => ({
        ...record,
        desktop: record.desktop ? { ...record.desktop, port: record.desktop.port + 1 } : null,
      }),
    ],
  ] as const)("rejects an attach after the durable %s changes", async (_name, mutate) => {
    const record = support.seedReadyNodeDesktop(`worker-node-desktop-stale-${_name}`);
    let current: WorkerEnvironmentRecord | undefined = record;
    const proof = nodeProof(record.nodeDeviceId!);
    const transport = pendingTransport({ proof, isProofCurrent: () => true });
    const streamed = fakeBroker();
    const carrier = createWorkerNodeDesktopCarrier({
      store: { get: () => current },
      desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });

    const observing = carrier.observe({ record, control: true });
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    current = mutate(record) as WorkerEnvironmentRecord;
    const stream = streamed.attachNext();

    await expect(observing).rejects.toThrow(/owner changed|connection is not current/u);
    expect(stream.destroyed).toBe(true);
  });

  it("rejects an attach after the node pairing proof changes", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-desktop-stale-pairing");
    let proofCurrent = true;
    const transport = pendingTransport({
      proof: nodeProof(record.nodeDeviceId!),
      isProofCurrent: () => proofCurrent,
    });
    const streamed = fakeBroker();
    const carrier = createWorkerNodeDesktopCarrier({
      store: support.testState.store,
      desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });

    const observing = carrier.observe({ record, control: true });
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    proofCurrent = false;
    const stream = streamed.attachNext();

    await expect(observing).rejects.toThrow("owner changed before attachment");
    expect(stream.destroyed).toBe(true);
  });

  it("deduplicates one exact launch and aborts it on owner teardown", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-desktop-launch");
    const transport = pendingTransport({
      proof: nodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    const carrier = createWorkerNodeDesktopCarrier({
      store: support.testState.store,
      desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: fakeBroker().broker });
    const app = support.DESKTOP.apps![0]!;

    await expect(
      carrier.launchApp({
        record,
        app: { ...app, executablePath: "/usr/local/bin/not-advertised" },
      }),
    ).rejects.toThrow("app descriptor is not current");
    expect(transport.invoke).not.toHaveBeenCalled();

    const first = carrier.launchApp({ record, app });
    const second = carrier.launchApp({ record, app });
    expect(second).toBe(first);
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    expect(transport.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ params: app, timeoutMs: 30_000 }),
    );

    await carrier.stop(record.environmentId, record.ownerEpoch);
    await expect(first).rejects.toThrow("invoke aborted");
    await expect(second).rejects.toThrow("invoke aborted");
    expect(transport.invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });

  it.each([
    { name: "ready", payloadJSON: '{"status":"ready"}', succeeds: true },
    { name: "missing receipt", payloadJSON: null, succeeds: false },
    { name: "open receipt", payloadJSON: '{"status":"ready","extra":true}', succeeds: false },
  ])("validates the closed node launcher $name result", async (testCase) => {
    const record = support.seedReadyNodeDesktop(
      `worker-node-desktop-${testCase.name.replaceAll(" ", "-")}`,
    );
    const proof = nodeProof(record.nodeDeviceId!);
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
      ok: true,
      payloadJSON: testCase.payloadJSON,
    }));
    const carrier = createWorkerNodeDesktopCarrier({
      store: support.testState.store,
      desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    });
    carrier.bindRuntime({
      transport: {
        listCurrentNodes: async () => [proof],
        hasCurrentRunner: (nodeId) => nodeId === proof.nodeId,
        isCurrent: () => true,
        invoke,
      },
      streamBroker: fakeBroker().broker,
    });
    const launched = carrier.launchApp({ record, app: support.DESKTOP.apps![0]! });

    if (testCase.succeeds) {
      await expect(launched).resolves.toBeUndefined();
    } else {
      await expect(launched).rejects.toThrow(/invalid result/u);
    }
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each(["durable owner", "pairing proof"] as const)(
    "rejects a successful launch receipt after the %s becomes stale",
    async (staleBoundary) => {
      const record = support.seedReadyNodeDesktop(`worker-node-launch-stale-${staleBoundary}`);
      let current: WorkerEnvironmentRecord | undefined = record;
      let proofCurrent = true;
      const proof = nodeProof(record.nodeDeviceId!);
      const invocation = deferred<{ ok: boolean; payloadJSON: string }>();
      const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(
        async () => await invocation.promise,
      );
      const carrier = createWorkerNodeDesktopCarrier({
        store: { get: () => current },
        desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
      });
      carrier.bindRuntime({
        transport: {
          listCurrentNodes: async () => [proof],
          hasCurrentRunner: (nodeId) => nodeId === proof.nodeId && proofCurrent,
          isCurrent: () => proofCurrent,
          invoke,
        },
        streamBroker: fakeBroker().broker,
      });

      const launched = carrier.launchApp({ record, app: support.DESKTOP.apps![0]! });
      await support.waitForFast(() => expect(invoke).toHaveBeenCalledOnce());
      if (staleBoundary === "durable owner") {
        current = { ...record, ownerEpoch: record.ownerEpoch + 1 };
      } else {
        proofCurrent = false;
      }
      invocation.resolve({ ok: true, payloadJSON: '{"status":"ready"}' });

      await expect(launched).rejects.toThrow("launch owner changed");
    },
  );
});
