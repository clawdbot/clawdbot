import { describe, expect, it } from "vitest";
import {
  NodeHostWorkerBridgeClient,
  parseNodeHostWorkerInput,
  stopNodeHostWorkerFromSignal,
} from "./worker-support.js";

describe("parseNodeHostWorkerInput", () => {
  it("accepts ordered input and cancel control frames", () => {
    expect(
      parseNodeHostWorkerInput(
        JSON.stringify({ type: "invoke-input", invokeId: "invoke-1", seq: 2, payloadJSON: "x" }),
      ),
    ).toEqual({ type: "invoke-input", invokeId: "invoke-1", seq: 2, payloadJSON: "x" });
    expect(
      parseNodeHostWorkerInput(JSON.stringify({ type: "invoke-cancel", invokeId: "invoke-1" })),
    ).toEqual({ type: "invoke-cancel", invokeId: "invoke-1" });
  });

  it("rejects malformed duplex control frames", () => {
    expect(
      parseNodeHostWorkerInput(
        JSON.stringify({ type: "invoke-input", invokeId: "invoke-1", seq: -1, payloadJSON: "x" }),
      ),
    ).toBeNull();
    expect(
      parseNodeHostWorkerInput(JSON.stringify({ type: "invoke-cancel", invokeId: "" })),
    ).toBeNull();
  });
});

describe("NodeHostWorkerBridgeClient", () => {
  it("forwards invoke results and events without creating gateway request waits", async () => {
    const messages: unknown[] = [];
    const client = new NodeHostWorkerBridgeClient((message) => messages.push(message));

    await client.request("node.invoke.result", { id: "invoke-1", ok: true });
    await client.request("node.event", { event: "exec.started", payloadJSON: "{}" });

    expect(messages).toEqual([
      { type: "invoke-result", result: { id: "invoke-1", ok: true } },
      { type: "node-event", event: { event: "exec.started", payloadJSON: "{}" } },
    ]);
  });

  it("tunnels invoke progress and waits for gateway acceptance", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const client = new NodeHostWorkerBridgeClient((message) => {
      messages.push(message as Record<string, unknown>);
    });

    let settled = false;
    const response = client
      .request("node.invoke.progress", {
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "a",
      })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(messages).toEqual([
      {
        type: "gateway-request",
        id: "gateway-1",
        method: "node.invoke.progress",
        params: { invokeId: "invoke-1", nodeId: "node-1", seq: 0, chunk: "a" },
        timeoutMs: 15_000,
      },
    ]);

    expect(
      client.handleResponse({
        type: "gateway-response",
        id: "gateway-1",
        ok: true,
        result: { ok: true },
      }),
    ).toBe(true);
    await response;
    expect(settled).toBe(true);
  });

  it("tunnels runtime gateway requests and resolves their matching response", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const client = new NodeHostWorkerBridgeClient((message) => {
      messages.push(message as Record<string, unknown>);
    });

    const response = client.request<{ bins: string[] }>("skills.bins", {}, { timeoutMs: 1_000 });
    expect(messages).toEqual([
      {
        type: "gateway-request",
        id: "gateway-1",
        method: "skills.bins",
        params: {},
        timeoutMs: 1_000,
      },
    ]);
    expect(
      client.handleResponse({
        type: "gateway-response",
        id: "gateway-1",
        ok: true,
        result: { bins: ["rg"] },
      }),
    ).toBe(true);
    await expect(response).resolves.toEqual({ bins: ["rg"] });
  });

  it("fails pending gateway requests when the app worker stops", async () => {
    const client = new NodeHostWorkerBridgeClient(() => {});
    const response = client.request("skills.bins", {}, { timeoutMs: 1_000 });

    client.close();

    await expect(response).rejects.toThrow("node-host worker stopped");
  });
});

describe("stopNodeHostWorkerFromSignal", () => {
  it("preserves the signal exit code when closing stdin emits EOF", async () => {
    const calls: string[] = [];
    let stopping = false;
    const stop = async (exitCode: number) => {
      if (stopping) {
        return;
      }
      stopping = true;
      calls.push(`stop:${exitCode}`);
    };

    await stopNodeHostWorkerFromSignal(
      {
        close: () => {
          calls.push("close");
          void stop(0);
        },
      },
      stop,
      143,
    );

    expect(calls).toEqual(["stop:143", "close"]);
  });
});
