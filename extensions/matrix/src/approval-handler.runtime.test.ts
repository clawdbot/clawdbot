import { describe, expect, it } from "vitest";
import { matrixApprovalNativeRuntime } from "./approval-handler.runtime.js";

describe("matrixApprovalNativeRuntime", () => {
  it("uses a longer code fence when resolved commands contain triple backticks", async () => {
    const result = await matrixApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg: {} as never,
      accountId: "default",
      context: {
        client: {} as never,
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      resolved: {
        id: "req-1",
        decision: "allow-once",
        ts: 0,
      },
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        decision: "allow-once",
        commandText: "echo ```danger```",
      } as never,
      entry: {} as never,
    });

    expect(result).toEqual({
      kind: "update",
      payload: [
        "Exec approval: Allowed once",
        "",
        "Command",
        "````",
        "echo ```danger```",
        "````",
      ].join("\n"),
    });
  });
});
