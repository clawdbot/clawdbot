import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateNodeInvokeProgressParams } from "../index.js";
import { NodeInvokeRequestEventSchema } from "./nodes.js";

describe("node protocol schemas", () => {
  it("accepts gateway-owned session attribution on node invoke requests", () => {
    const request = {
      id: "invoke-1",
      nodeId: "node-1",
      command: "system.run",
      paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
      timeoutMs: 30_000,
      idempotencyKey: "request-1",
      sessionKey: "agent:main:main",
    };

    expect(Value.Check(NodeInvokeRequestEventSchema, request)).toBe(true);
    expect(Value.Check(NodeInvokeRequestEventSchema, { ...request, sessionKey: null })).toBe(true);
    expect(Value.Check(NodeInvokeRequestEventSchema, { ...request, sessionKey: "" })).toBe(false);
    expect(Value.Check(NodeInvokeRequestEventSchema, { ...request, extra: true })).toBe(false);
    for (const forbidden of ["attribution", "passportId", "principalId", "instanceId"]) {
      expect(Value.Check(NodeInvokeRequestEventSchema, { ...request, [forbidden]: "forged" })).toBe(
        false,
      );
    }
  });

  it("accepts bounded progress chunks and rejects extra fields", () => {
    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "stdout line",
      }),
    ).toBe(true);

    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "x".repeat(16 * 1024 + 1),
      }),
    ).toBe(false);

    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "stdout line",
        extra: "not allowed",
      }),
    ).toBe(false);
  });
});
