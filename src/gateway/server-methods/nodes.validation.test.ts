import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { environmentsHandlers } from "./environments.js";
import { nodeHandlers } from "./nodes.js";
import { nodePendingWorkHandlers } from "./nodes.pending-work.js";
import { pushHandlers } from "./push.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

const handlers: GatewayRequestHandlers = {
  ...nodeHandlers,
  ...nodePendingWorkHandlers,
  ...pushHandlers,
  ...environmentsHandlers,
};

describe("node and environment request validation", () => {
  it.each<[string, Record<string, unknown>]>([
    ["node.pair.list", { unexpected: true }],
    ["node.pair.approve", { requestId: 1 }],
    ["node.pair.reject", { requestId: 1 }],
    ["node.pair.remove", { nodeId: 1 }],
    ["node.rename", { nodeId: "node-1", displayName: 1 }],
    ["node.list", { unexpected: true }],
    ["node.describe", { nodeId: 1 }],
    ["node.pluginTools.update", { tools: {} }],
    ["node.skills.update", { skills: {} }],
    ["node.pending.pull", { unexpected: true }],
    ["node.pending.ack", { ids: [] }],
    ["node.pending.drain", { maxItems: 0 }],
    ["node.pending.enqueue", { nodeId: "node-1", type: "unknown" }],
    [
      "node.invoke",
      { nodeId: "node-1", command: "debug.ping", idempotencyKey: "request-1", timeoutMs: "1" },
    ],
    ["node.invoke.result", { id: "invoke-1", nodeId: "node-1", ok: "yes" }],
    ["node.invoke.progress", { invokeId: "invoke-1", nodeId: "node-1", seq: -1, chunk: "" }],
    ["node.event", { event: 1 }],
    ["push.test", { nodeId: 1 }],
    ["push.web.vapidPublicKey", { unexpected: true }],
    [
      "push.web.subscribe",
      { endpoint: "https://push.example.test/1", keys: { p256dh: "key", auth: 1 } },
    ],
    ["push.web.unsubscribe", { endpoint: "http://push.example.test/1" }],
    ["push.web.test", { title: 1 }],
    ["push.web.preferences.get", { endpoint: "http://push.example.test/1" }],
    [
      "push.web.preferences.set",
      {
        endpoint: "https://push.example.test/1",
        scope: "user",
        preferences: { enabled: true, label: "phone" },
      },
    ],
    ["environments.list", { unexpected: true }],
    ["environments.status", { environmentId: 1 }],
    ["environments.create", { profileId: "profile-1", idempotencyKey: 1 }],
    ["environments.destroy", { environmentId: "env-1", force: "yes" }],
    ["worker.desktop.observe", { environmentId: "env-1", control: "yes" }],
    ["worker.desktop.launch", { environmentId: "env-1", app: "unknown" }],
    ["desktop.observe", { source: { kind: "host" }, control: "yes" }],
    ["desktop.launch", { source: { kind: "environment", environmentId: "env-1" }, app: "unknown" }],
  ])("rejects malformed %s before accessing runtime state", async (method, params) => {
    const accessRuntime = vi.fn(() => {
      throw new Error("malformed request reached runtime state");
    });
    const context = new Proxy({} as GatewayRequestContext, { get: accessRuntime });
    const respond = vi.fn<RespondFn>();
    const originalParams = structuredClone(params);
    const handler = expectDefined(handlers[method], `${method} handler`);

    await handler({
      req: { type: "req", id: "invalid-request", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: expect.stringMatching(`^invalid ${method.replaceAll(".", "\\.")} params: .+`),
        },
      ],
    ]);
    expect(accessRuntime).not.toHaveBeenCalled();
    expect(params).toEqual(originalParams);
  });
});
