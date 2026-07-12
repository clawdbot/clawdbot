// Tests approval view model formatting for prompts and decisions.
import { describe, expect, it } from "vitest";
import {
  buildPendingApprovalView,
  isTypedApprovalActionView,
  resolveApprovalRequestKind,
} from "./approval-view-model.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

describe("buildPendingApprovalView", () => {
  it("keeps legacy action views valid while the host guard rejects untyped actions", () => {
    expect(
      isTypedApprovalActionView({
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve legacy deny",
      }),
    ).toBe(false);
  });

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
    expect(view.actions.every(isTypedApprovalActionView)).toBe(true);
    expect(view.actions[0]?.action).toEqual({
      type: "approval",
      approvalId: "approval-id",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("uses the typed request owner instead of approval id spelling", () => {
    const request: PluginApprovalRequest = {
      id: "custom-id-without-prefix",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "Use protected tool",
        description: "The plugin needs operator consent.",
      },
    };

    expect(resolveApprovalRequestKind(request)).toBe("plugin");
    const view = buildPendingApprovalView(request);
    expect(view.approvalKind).toBe("plugin");
    expect(view.actions[0]?.action).toEqual({
      type: "approval",
      approvalId: "custom-id-without-prefix",
      approvalKind: "plugin",
      decision: "allow-once",
    });
  });

  it("keeps the fail-closed plugin decision in channel-facing actions", () => {
    const request: PluginApprovalRequest = {
      id: "plugin-approval",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "Use protected tool",
        description: "The plugin needs operator consent.",
        allowedDecisions: ["allow-once"],
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.actions.map((action) => action.action)).toEqual([
      {
        type: "approval",
        approvalId: "plugin-approval",
        approvalKind: "plugin",
        decision: "allow-once",
      },
      {
        type: "approval",
        approvalId: "plugin-approval",
        approvalKind: "plugin",
        decision: "deny",
      },
    ]);
  });

  it.each([
    { request: {} },
    { request: { command: "echo hi", title: "Ambiguous", description: "Ambiguous" } },
  ])("rejects a request payload without exactly one owner: %j", (request) => {
    expect(() => resolveApprovalRequestKind(request)).toThrow("exactly one owner");
  });
});
