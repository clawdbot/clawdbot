import { describe, expect, it } from "vitest";
import { NodeHostWorkerBridgeClient, stopNodeHostWorkerFromSignal } from "./worker-support.js";

describe("NodeHostWorkerBridgeClient", () => {
  it("forwards invoke results and events without creating gateway request waits", async () => {
    const messages: unknown[] = [];
    const client = new NodeHostWorkerBridgeClient((message) => messages.push(message));

    await client.request("node.invoke.result", { id: "invoke-1", ok: true });
    await client.request("node.invoke.progress", { invokeId: "invoke-1", seq: 0, chunk: "a" });
    await client.request("node.event", { event: "exec.started", payloadJSON: "{}" });

    expect(messages).toEqual([
      { type: "invoke-result", result: { id: "invoke-1", ok: true } },
      {
        type: "invoke-progress",
        progress: { invokeId: "invoke-1", seq: 0, chunk: "a" },
      },
      { type: "node-event", event: { event: "exec.started", payloadJSON: "{}" } },
    ]);
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
