import { describe, expect, it } from "vitest";
import { buildPendingApprovalView } from "./approval-view-model.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

describe("buildPendingApprovalView", () => {
  it("passes command analysis through exec approval views", () => {
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: 'ls | grep "stuff" | python -c \'print("hi")\'',
        host: "node",
        ask: "always",
        commandAnalysis: {
          commandCount: 1,
          nestedCommandCount: 0,
          riskKinds: ["inline-eval"],
          warningLines: ["Contains inline-eval: python -c"],
        },
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.approvalKind).toBe("exec");
    if (view.approvalKind !== "exec") {
      throw new Error("expected exec approval view");
    }
    expect(view.commandAnalysis?.warningLines).toEqual(["Contains inline-eval: python -c"]);
  });

  it("uses custom plugin approval actions when provided", () => {
    const request: PluginApprovalRequest = {
      id: "plugin:approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "World ID approval",
        description: "Approve in World app",
        actions: [
          {
            kind: "command",
            label: "Open AgentKit",
            style: "primary",
            command: "/agentkit approve plugin:approval-1",
          },
        ],
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.approvalKind).toBe("plugin");
    expect(view.actions).toEqual([
      {
        kind: "command",
        label: "Open AgentKit",
        style: "primary",
        command: "/agentkit approve plugin:approval-1",
      },
    ]);
  });
});
