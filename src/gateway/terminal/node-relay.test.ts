import { describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { type NodeInvokeResult, NodeRegistry } from "../node-registry.js";
import { createNodeRelayBackend } from "./node-relay.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("createNodeRelayBackend", () => {
  it("waits for pairing validation and dispatch instead of the final node exit", async () => {
    const pairingState = deferred<{ identity: string; generation: string }>();
    const frames: string[] = [];
    const resolveCurrentPairingState = vi.fn(async () => await pairingState.promise);
    const registry = new NodeRegistry({
      resolveCurrentPairingState,
    });
    registry.register(
      {
        connId: "conn-validated",
        usesSharedGatewayAuth: false,
        socket: {
          send(frame: unknown) {
            if (typeof frame === "string") {
              frames.push(frame);
            }
          },
        },
        connect: {
          client: { id: "openclaw-node-host", mode: "node" },
          device: { id: "node-validated" },
          commands: ["codex.terminal.resume.v1"],
        },
      } as never,
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );

    const opening = createNodeRelayBackend({
      registry,
      nodeId: "node-validated",
      expectedConnId: "conn-validated",
      expectedPairingGeneration: "generation-a",
      command: "codex.terminal.resume.v1",
      params: { threadId: "thread" },
    });
    await vi.waitFor(() =>
      expect(resolveCurrentPairingState).toHaveBeenCalledWith("node-validated"),
    );
    expect(frames).toEqual([]);

    pairingState.resolve({ identity: "identity-a", generation: "generation-a" });
    const backend = await withTestTimeout(
      opening,
      500,
      "timed out waiting for node terminal dispatch readiness",
    );

    expect(JSON.parse(frames[0] ?? "{}")).toMatchObject({
      event: "node.invoke.request",
      payload: {
        nodeId: "node-validated",
        command: "codex.terminal.resume.v1",
      },
    });
    backend.kill();
    registry.unregister("conn-validated");
  });

  it("relays progress, input, resize, cancellation, and the node exit result", async () => {
    const invokeResult = deferred<NodeInvokeResult>();
    let onProgress: ((chunk: string) => void) | undefined;
    let signal: AbortSignal | undefined;
    const sendInvokeInput = vi.fn();
    const registry = {
      invoke: vi.fn(
        (params: {
          onDispatchReady?: (id: string) => void;
          onProgress?: (chunk: string) => void;
          signal?: AbortSignal;
        }) => {
          onProgress = params.onProgress;
          signal = params.signal;
          params.onDispatchReady?.("invoke-1");
          return invokeResult.promise;
        },
      ),
      sendInvokeInput,
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "codex.terminal.resume.v1",
      params: { threadId: "thread" },
    });
    const data = vi.fn();
    const exit = vi.fn();
    backend.onData(data);
    backend.onExit(exit);

    onProgress?.("");
    onProgress?.("hello");
    expect(data).toHaveBeenCalledWith("hello");
    backend.write("keys");
    backend.resize(100, 30);
    expect(sendInvokeInput).toHaveBeenNthCalledWith(1, "invoke-1", {
      kind: "data",
      data: "keys",
    });
    expect(sendInvokeInput).toHaveBeenNthCalledWith(2, "invoke-1", {
      kind: "resize",
      cols: 100,
      rows: 30,
    });

    invokeResult.resolve({ ok: true, payloadJSON: JSON.stringify({ exitCode: 7, signal: 15 }) });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith({ exitCode: 7, signal: 15 }));

    backend.kill();
    expect(signal?.aborted).toBe(true);
  });

  it("maps node disconnect failures to terminal errors", async () => {
    const registry = {
      invoke: vi.fn((params: { onDispatchReady?: (id: string) => void }) => {
        params.onDispatchReady?.("invoke-2");
        return Promise.resolve({
          ok: false,
          error: { code: "NOT_CONNECTED", message: "node disconnected" },
        });
      }),
      sendInvokeInput: vi.fn(),
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "anthropic.claude.terminal.resume.v1",
      params: {},
    });
    const exit = vi.fn();
    backend.onExit(exit);
    await vi.waitFor(() =>
      expect(exit).toHaveBeenCalledWith({ error: "NOT_CONNECTED: node disconnected" }),
    );
  });

  it("pins the expected connection and reports route changes through onExit", async () => {
    const invoke = vi.fn((params: { onDispatchReady?: (id: string) => void }) => {
      params.onDispatchReady?.("invoke-route-changed");
      return Promise.resolve({
        ok: false,
        error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
      });
    });
    const registry = { invoke, sendInvokeInput: vi.fn() } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      nodeId: "node-1",
      expectedConnId: "conn-authorized",
      expectedPairingGeneration: "generation-authorized",
      command: "codex.terminal.resume.v1",
      params: {},
    });
    const exit = vi.fn();
    backend.onExit(exit);

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        expectedConnId: "conn-authorized",
        expectedPairingGeneration: "generation-authorized",
      }),
    );
    await vi.waitFor(() =>
      expect(exit).toHaveBeenCalledWith({
        error: "ROUTE_CHANGED: node connection changed before dispatch",
      }),
    );
  });

  it("bounds output buffered before onData registration", async () => {
    let onProgress: ((chunk: string) => void) | undefined;
    const registry = {
      invoke: vi.fn(
        (params: {
          onDispatchReady?: (id: string) => void;
          onProgress?: (chunk: string) => void;
        }) => {
          onProgress = params.onProgress;
          params.onDispatchReady?.("invoke-buffered");
          return Promise.resolve({ ok: true });
        },
      ),
      sendInvokeInput: vi.fn(),
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "codex.terminal.resume.v1",
      params: {},
    });
    const chunkChars = 256 * 1024;
    onProgress?.("a".repeat(chunkChars));
    onProgress?.("b".repeat(chunkChars));
    onProgress?.("c".repeat(chunkChars));
    const data = vi.fn();

    backend.onData(data);

    expect(data.mock.calls.map(([chunk]) => chunk)).toEqual([
      "b".repeat(chunkChars),
      "c".repeat(chunkChars),
    ]);

    const surrogateBackend = await createNodeRelayBackend({
      registry,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "codex.terminal.resume.v1",
      params: {},
    });
    const capChars = 512 * 1024;
    onProgress?.(`x😀${"y".repeat(capChars - 1)}`);
    const surrogateData = vi.fn();

    surrogateBackend.onData(surrogateData);

    expect(surrogateData).toHaveBeenCalledWith("y".repeat(capChars - 1));
  });

  it("never splits a surrogate pair at the input chunk boundary", async () => {
    const sendInvokeInput = vi.fn();
    const registry = {
      invoke: vi.fn((params: { onDispatchReady?: (id: string) => void }) => {
        params.onDispatchReady?.("invoke-input");
        return Promise.resolve({ ok: true });
      }),
      sendInvokeInput,
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "codex.terminal.resume.v1",
      params: {},
    });
    const input = `${"a".repeat(2047)}😀b`;

    backend.write(input);

    const chunks = sendInvokeInput.mock.calls.map(
      (call) => (call[1] as { kind: "data"; data: string }).data,
    );
    expect(chunks.join("")).toBe(input);
    expect(chunks).toEqual(["a".repeat(2047), "😀b"]);
  });
});
