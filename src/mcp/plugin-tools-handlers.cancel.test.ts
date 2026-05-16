import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createToolsMcpServer } from "./tools-stdio-server.js";

describe("plugin tools MCP cancellation", () => {
  it("forwards host cancellation to tool.execute", async () => {
    let resolveObservedSignal: (signal: AbortSignal | undefined) => void;
    const observedSignal = new Promise<AbortSignal | undefined>((resolve) => {
      resolveObservedSignal = resolve;
    });
    let abortObserved = false;

    const tool = {
      name: "probe_cancel",
      description: "Probe cancellation forwarding",
      parameters: { type: "object", properties: {} },
      execute: async (_toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        resolveObservedSignal(signal);
        await new Promise<void>((resolve, reject) => {
          if (!signal) {
            reject(new Error("tool.execute did not receive AbortSignal"));
            return;
          }
          if (signal.aborted) {
            abortObserved = true;
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              resolve();
            },
            { once: true },
          );
        });
        return { content: [{ type: "text", text: "done" }] };
      },
    } as unknown as AnyAgentTool;

    const server = createToolsMcpServer({ name: "test", tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const controller = new AbortController();
      const callPromise = client.callTool({ name: "probe_cancel", arguments: {} }, undefined, {
        signal: controller.signal,
      });
      const signal = await observedSignal;

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      controller.abort();

      await expect(callPromise).rejects.toBeDefined();
      expect(abortObserved).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
