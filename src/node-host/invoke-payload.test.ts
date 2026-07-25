import { describe, expect, it } from "vitest";
import { coerceNodeInvokeInputPayload } from "./invoke-payload.js";

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
