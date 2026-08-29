import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type {
  ExecApprovalPendingView,
  PluginApprovalPendingView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { describe, expect, it } from "vitest";
import {
  buildMSTeamsCanonicalApprovalTerminalCard,
  buildMSTeamsExpiredApprovalCard,
  buildMSTeamsPendingApprovalCard,
  buildMSTeamsResolvedApprovalCard,
} from "./approval-card.js";

function createExecPendingView(): ExecApprovalPendingView {
  return {
    approvalId: "approval-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    metadata: [
      { label: "Agent", value: "main" },
      { label: "Host", value: "gateway" },
    ],
    commandText: "npm run deploy",
    actions: [
      {
        decision: "allow-once",
        label: "Approve once",
        style: "success",
        command: "/approve approval-1 allow-once",
      },
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve approval-1 deny",
      },
    ],
    expiresAtMs: 61_000,
  };
}

function createPluginPendingView(): PluginApprovalPendingView {
  return {
    approvalId: "plugin-1",
    approvalKind: "plugin",
    phase: "pending",
    title: "Publish production changes",
    description: "Allow the deploy plugin to update production.",
    metadata: [{ label: "Plugin", value: "deploy" }],
    severity: "warning",
    actions: [
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve plugin-1 deny",
      },
    ],
    expiresAtMs: 31_000,
  };
}

describe("Microsoft Teams approval Adaptive Cards", () => {
  it("renders an exec command, ordered metadata, and only the available namespaced actions", () => {
    const result = buildMSTeamsPendingApprovalCard({
      view: createExecPendingView(),
      nowMs: 1_000,
    });

    expect(result.card).toEqual({
      type: "AdaptiveCard",
      version: "1.5",
      body: [
        {
          type: "TextBlock",
          text: "Exec Approval Required",
          weight: "Bolder",
          size: "Medium",
          wrap: true,
        },
        { type: "TextBlock", text: "Expires in 60s", isSubtle: true, wrap: true },
        { type: "TextBlock", text: "Command", weight: "Bolder", wrap: true },
        { type: "TextBlock", text: "npm run deploy", fontType: "Monospace", wrap: true },
        {
          type: "FactSet",
          facts: [
            { title: "Approval ID:", value: "approval-1" },
            { title: "Agent:", value: "main" },
            { title: "Host:", value: "gateway" },
          ],
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "Approve once",
          data: { openclawAction: "approval", token: expect.any(String) },
        },
        {
          type: "Action.Submit",
          title: "Deny",
          data: { openclawAction: "approval", token: expect.any(String) },
        },
      ],
    });
    expect(result.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(result.actionTokens.map(({ token }) => token)).toEqual(
      (result.card.actions as Array<{ data: { token: string } }>).map(({ data }) => data.token),
    );
    expect(new Set(result.actionTokens.map(({ token }) => token)).size).toBe(2);
  });

  it("presents plugin-owned request details and never invents unavailable approval actions", () => {
    const result = buildMSTeamsPendingApprovalCard({
      view: createPluginPendingView(),
      nowMs: 1_000,
    });

    expect(result.card).toMatchObject({
      body: [
        { text: "Plugin Approval Required" },
        { text: "Expires in 30s" },
        { text: "Request" },
        { text: "Publish production changes" },
        { text: "Allow the deploy plugin to update production." },
        {
          facts: [
            { title: "Approval ID:", value: "plugin-1" },
            { title: "Plugin:", value: "deploy" },
          ],
        },
      ],
      actions: [
        {
          title: "Deny",
          data: { openclawAction: "approval", token: expect.any(String) },
        },
      ],
    });
    expect(result.allowedDecisions).toEqual(["deny"]);
  });

  it("removes approval actions from resolved and expired cards", () => {
    const { actions: _actions, expiresAtMs: _expiresAtMs, ...view } = createExecPendingView();
    const resolved = buildMSTeamsResolvedApprovalCard({
      ...view,
      phase: "resolved",
      decision: "allow-always",
      resolvedBy: "alice",
    });
    const expired = buildMSTeamsExpiredApprovalCard({ ...view, phase: "expired" });

    expect(resolved.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Exec Approval: Allowed always" }),
        expect.objectContaining({ text: "Resolved by alice" }),
      ]),
    );
    expect(expired.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Exec Approval Expired" }),
        expect.objectContaining({
          text: "This approval request expired before it was resolved.",
        }),
      ]),
    );
    expect(resolved).not.toHaveProperty("actions");
    expect(expired).not.toHaveProperty("actions");
  });

  it("displays the canonical winning decision when another surface resolved the approval first", () => {
    const result: ApprovalResolveResult = {
      applied: false,
      approval: {
        id: "approval-1",
        urlPath: "/approve/approval-1",
        createdAtMs: 1,
        expiresAtMs: 61_000,
        resolvedAtMs: 2,
        status: "denied",
        decision: "deny",
        reason: "user",
        presentation: {
          kind: "exec",
          commandText: "npm run deploy",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    };

    const card = buildMSTeamsCanonicalApprovalTerminalCard(result);

    expect(card).toMatchObject({
      body: [
        { text: "Exec Approval: Denied" },
        { text: "Already resolved" },
        { text: "Command" },
        { text: "npm run deploy" },
        {
          facts: [
            { title: "Approval ID:", value: "approval-1" },
            { title: "Status:", value: "denied" },
            { title: "Decision:", value: "deny" },
            { title: "Reason:", value: "user" },
          ],
        },
      ],
    });
    expect(card).not.toHaveProperty("actions");
  });
});
