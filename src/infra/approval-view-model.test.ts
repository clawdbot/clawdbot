// Tests approval view model formatting for prompts and decisions.
import { describe, expect, it } from "vitest";
import { normalizeApprovalRequest, resolveApprovalRequestKind } from "./approval-types.js";
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
        scope: {
          kind: "message-send",
          target: "email",
          recipientCount: 3,
          recipients: ["alice@example.com", "bob@example.com"],
          audience: "external",
        },
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.approvalKind).toBe("exec");
    if (view.approvalKind !== "exec") {
      throw new Error("expected exec approval view");
    }
    expect(view.commandAnalysis?.warningLines).toEqual(["Contains inline-eval: python -c"]);
    expect(view.scope).toEqual(request.request.scope);
    expect(view.metadata).toContainEqual({
      label: "Scope",
      value:
        "Send to 3 recipients via email (external): alice@example.com, bob@example.com, +1 more",
    });
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
        scope: { kind: "external-post", target: "github", visibility: "public" },
      },
    };

    expect(resolveApprovalRequestKind(request)).toBe("plugin");
    const view = buildPendingApprovalView(request);
    expect(view.approvalKind).toBe("plugin");
    expect(view.scope).toEqual(request.request.scope);
    expect(view.metadata).toContainEqual({ label: "Scope", value: "Post publicly to github" });
    expect(view.actions[0]?.action).toEqual({
      type: "approval",
      approvalId: "custom-id-without-prefix",
      approvalKind: "plugin",
      decision: "allow-once",
    });
  });

  const approvalRequestBase = { id: "approval-id", createdAtMs: 1, expiresAtMs: 2 };

  it("surfaces the requested cwd next to the canonical cwd when they differ", () => {
    const request: ExecApprovalRequest = {
      ...approvalRequestBase,
      request: {
        command: "echo hi",
        host: "node",
        cwd: "/srv/real-work",
        systemRunPlan: {
          argv: ["echo", "hi"],
          commandText: "echo hi",
          cwd: "/srv/real-work",
          requestedCwd: "/srv/link-work",
          agentId: null,
          sessionKey: null,
        },
      },
    };

    const view = buildPendingApprovalView(request);
    if (view.approvalKind !== "exec") {
      throw new Error("expected exec approval view");
    }
    expect(view.metadata).toContainEqual({ label: "CWD", value: "/srv/real-work" });
    expect(view.metadata).toContainEqual({ label: "Requested CWD", value: "/srv/link-work" });
  });

  it("omits the requested cwd row when it matches the canonical cwd", () => {
    const request: ExecApprovalRequest = {
      ...approvalRequestBase,
      request: {
        command: "echo hi",
        host: "node",
        cwd: "/srv/real-work",
        systemRunPlan: {
          argv: ["echo", "hi"],
          commandText: "echo hi",
          cwd: "/srv/real-work",
          requestedCwd: "/srv/real-work",
          agentId: null,
          sessionKey: null,
        },
      },
    };

    const view = buildPendingApprovalView(request);
    if (view.approvalKind !== "exec") {
      throw new Error("expected exec approval view");
    }
    expect(view.metadata.filter((row) => row.label.includes("CWD"))).toEqual([
      { label: "CWD", value: "/srv/real-work" },
    ]);
  });

  it.each([
    { request: { ...approvalRequestBase, request: { command: "echo safe" } }, metadata: [] },
    {
      request: {
        ...approvalRequestBase,
        request: { title: "Use protected tool", description: "The plugin needs consent." },
      },
      metadata: [{ label: "Severity", value: "Warning" }],
    },
  ])("preserves existing metadata when no approval scope is declared", ({ request, metadata }) => {
    const view = buildPendingApprovalView(request);

    expect(view.metadata).toEqual(metadata);
    expect(view).not.toHaveProperty("scope");
  });

  it("does not trust conflicting approval kind metadata", () => {
    const request: PluginApprovalRequest = {
      id: "plugin-approval",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "Use protected tool",
        description: "The plugin needs operator consent.",
      },
    };
    Object.defineProperty(request, "approvalKind", { value: "exec", enumerable: true });

    expect(normalizeApprovalRequest(request).approvalKind).toBe("plugin");
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
