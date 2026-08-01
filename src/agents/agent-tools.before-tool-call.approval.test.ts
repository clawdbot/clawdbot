import { describe, expect, it } from "vitest";
import { resolveBeforeToolCallApprovalOutcome } from "./agent-tools.before-tool-call.approval.js";

describe("before_tool_call approval snapshots", () => {
  it("detaches deferred approval params from mutable hook and caller objects", async () => {
    const baseParams = { command: "safe", options: { cwd: "/safe" } };
    const overrideParams = { env: { MODE: "safe" } };

    const outcome = await resolveBeforeToolCallApprovalOutcome({
      result: {
        requireApproval: {
          pluginId: "policy",
          title: "Needs approval",
          description: "Approval needed",
        },
        params: overrideParams,
      },
      approvalMode: "defer",
      toolName: "bash",
      baseParams,
    });

    baseParams.options.cwd = "/unapproved";
    overrideParams.env.MODE = "unapproved";

    expect(outcome).toMatchObject({
      blocked: false,
      params: { command: "safe", options: { cwd: "/safe" } },
      deferredApproval: {
        baseParams: { command: "safe", options: { cwd: "/safe" } },
        overrideParams: { env: { MODE: "safe" } },
      },
    });
    if (!outcome || outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred approval outcome");
    }
    (outcome.params as typeof baseParams).options.cwd = "/outcome-mutated";
    expect(outcome.deferredApproval.baseParams).toEqual({
      command: "safe",
      options: { cwd: "/safe" },
    });
  });

  const sharedMemoryCases: Array<
    [
      string,
      {
        baseParams: Record<string, unknown>;
        overrideParams?: Record<string, unknown>;
      },
    ]
  > = [
    ["base params", { baseParams: { shared: new Uint8Array(new SharedArrayBuffer(4)) } }],
    [
      "override params",
      {
        baseParams: { command: "safe" },
        overrideParams: { shared: new Uint8Array(new SharedArrayBuffer(4)) },
      },
    ],
  ];

  it.each(sharedMemoryCases)("rejects shared memory in %s", async (_name, values) => {
    await expect(
      resolveBeforeToolCallApprovalOutcome({
        result: {
          requireApproval: {
            pluginId: "policy",
            title: "Needs approval",
            description: "Approval needed",
          },
          params: values.overrideParams,
        },
        approvalMode: "defer",
        toolName: "bash",
        baseParams: values.baseParams,
      }),
    ).rejects.toThrow("before_tool_call mutable input isolation failed");
  });
});
