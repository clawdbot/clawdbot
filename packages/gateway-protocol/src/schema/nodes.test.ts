import { describe, expect, it } from "vitest";
import { validateNodeInvokeProgressParams } from "../index.js";

describe("node protocol schemas", () => {
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
