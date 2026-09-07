import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { consumeTrackedToolExecutionStarted } from "../agents/agent-tools.before-tool-call.state.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  PluginRegistryResourceScope,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createToolsMcpServer } from "./tools-stdio-server.js";

// Plugin MCP cancellation tests cover cancellation of in-flight plugin tool calls.

describe("plugin tools MCP cancellation", () => {
  it("forwards host cancellation to tool.execute", async () => {
    let resolveObservedSignal: (signal: AbortSignal | undefined) => void;
    const observedSignal = new Promise<AbortSignal | undefined>((resolve) => {
      resolveObservedSignal = resolve;
    });
    let abortObserved = false;
    let observedToolCallId: string | undefined;

    const tool = {
      name: "probe_cancel",
      description: "Probe cancellation forwarding",
      parameters: { type: "object", properties: {} },
      execute: async (toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        observedToolCallId = toolCallId;
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
      expect(observedToolCallId).toBeDefined();
      if (!observedToolCallId) {
        throw new Error("tool.execute did not receive a call id");
      }
      expect(consumeTrackedToolExecutionStarted(observedToolCallId)).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MCP tool resource lifetime", () => {
  it.each(["server", "client"] as const)(
    "keeps SQLite open after %s close until an admitted tool actually settles",
    async (closingSide) => {
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE proof (value INTEGER)");
      const registry = createEmptyPluginRegistry();
      const disposalStarted = createDeferredCore();
      const finishDisposal = createDeferredCore();
      const resources = new PluginRegistryResourceScope();
      resources.adopt({ registry, ...createPluginRegistryResourceOwner(registry, "scoped") });
      registerPluginRegistryResourceDisposer(registry, "fixture", {
        id: "database",
        async dispose() {
          disposalStarted.resolve();
          await finishDisposal.promise;
          db.close();
        },
      });
      const started = createDeferredCore();
      const cancelled = createDeferredCore();
      const finish = createDeferredCore();
      const server = createToolsMcpServer({
        name: "resource-lifetime",
        resources,
        tools: [
          {
            name: "write",
            label: "Write",
            description: "Write a synthetic row",
            parameters: { type: "object", properties: {} },
            async execute(_id, _args, signal) {
              signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
              started.resolve();
              await finish.promise;
              db.prepare("INSERT INTO proof VALUES (?)").run(1);
              return { content: [{ type: "text", text: "written" }], details: {} };
            },
          },
        ],
      });
      const client = new Client({ name: "resource-lifetime-client", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = client.callTool({ name: "write", arguments: {} }).catch(() => undefined);
      await started.promise;
      if (closingSide === "client") {
        await client.close();
      }
      let closed = false;
      const close = server.close().then(() => {
        closed = true;
      });
      try {
        await cancelled.promise;
        expect(db.isOpen).toBe(true);
        expect(closed).toBe(false);
        finish.resolve();
        await disposalStarted.promise;
        await setImmediate();
        expect(db.isOpen).toBe(true);
        expect(closed).toBe(false);
      } finally {
        finish.resolve();
        finishDisposal.resolve();
        await close;
        await result;
        await client.close();
        await drainPluginRegistryResourceDisposals();
      }
      expect(db.isOpen).toBe(false);
    },
  );
});
