import { describe, expect, it } from "vitest";
import { validateNodeInvokeInputEvent } from "../index.js";

describe("node.invoke.input protocol", () => {
  it("accepts ordered bounded frames and rejects oversized or open-ended payloads", () => {
    expect(
      validateNodeInvokeInputEvent({
        id: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        payloadJSON: '{"kind":"data","data":"x"}',
      }),
    ).toBe(true);
    expect(
      validateNodeInvokeInputEvent({
        id: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        payloadJSON: "x".repeat(16 * 1024 + 1),
      }),
    ).toBe(false);
    expect(
      validateNodeInvokeInputEvent({
        id: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        payloadJSON: "{}",
        argv: ["sh"],
      }),
    ).toBe(false);
  });
});
