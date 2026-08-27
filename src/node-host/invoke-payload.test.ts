import { describe, expect, it } from "vitest";
import { coerceNodeInvokeInputPayload, coerceNodeInvokePayload } from "./invoke-payload.js";

describe("coerceNodeInvokePayload", () => {
  it.each([
    ["preserves the exact owning session", "agent:main:managed", "agent:main:managed"],
    ["normalizes the owning session", "  agent:main:managed  ", "agent:main:managed"],
    ["omits an absent owning session", undefined, undefined],
    ["omits a blank owning session", "  ", undefined],
    ["omits a non-string owning session", 42, undefined],
  ])("%s", (_name, sessionKey, expectedSessionKey) => {
    expect(
      coerceNodeInvokePayload({
        id: "invoke-1",
        nodeId: "node-1",
        command: "plugin.workspace",
        sessionKey,
      }),
    ).toEqual({
      id: "invoke-1",
      nodeId: "node-1",
      command: "plugin.workspace",
      paramsJSON: null,
      timeoutMs: null,
      idempotencyKey: null,
      ...(expectedSessionKey ? { sessionKey: expectedSessionKey } : {}),
    });
  });
});

describe("coerceNodeInvokeInputPayload", () => {
  it("accepts a bounded well-formed input payload", () => {
    expect(
      coerceNodeInvokeInputPayload({
        id: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        payloadJSON: JSON.stringify({ kind: "data", data: "keys" }),
      }),
    ).toEqual({
      invokeId: "invoke-1",
      nodeId: "node-1",
      seq: 0,
      payloadJSON: JSON.stringify({ kind: "data", data: "keys" }),
    });
  });

  it.each([
    [
      "oversized payloadJSON",
      { id: "i", nodeId: "n", seq: 0, payloadJSON: "x".repeat(16 * 1024 + 1) },
    ],
    ["negative seq", { id: "i", nodeId: "n", seq: -1, payloadJSON: "{}" }],
    ["fractional seq", { id: "i", nodeId: "n", seq: 0.5, payloadJSON: "{}" }],
    ["array frame", []],
    ["string frame", "input"],
  ])("rejects %s", (_name, payload) => {
    expect(coerceNodeInvokeInputPayload(payload)).toBeNull();
  });
});
