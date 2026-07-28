import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  NodeInvokeCancelEventSchema,
  type NodeInvokeCancelEvent,
  validateNodeInvokeProgressParams,
} from "../index.js";
import { ProtocolSchemas } from "./protocol-schemas.js";

describe("node protocol schemas", () => {
  it("publishes the closed node invoke cancellation payload", () => {
    const payload: NodeInvokeCancelEvent = {
      invokeId: "invoke-1",
      nodeId: "node-1",
    };

    expect(ProtocolSchemas.NodeInvokeCancelEvent).toBe(NodeInvokeCancelEventSchema);
    expect(Value.Check(NodeInvokeCancelEventSchema, payload)).toBe(true);
    expect(Value.Check(NodeInvokeCancelEventSchema, { ...payload, invokeId: "" })).toBe(false);
    expect(Value.Check(NodeInvokeCancelEventSchema, { invokeId: "invoke-1" })).toBe(false);
    expect(Value.Check(NodeInvokeCancelEventSchema, { ...payload, extra: true })).toBe(false);
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
