import { describe, expect, it } from "vitest";
import {
  projectSessionApprovalReplay,
  reconcileSessionApprovalEvent,
} from "./session-approval-projection.ts";

const pendingPluginApproval = {
  id: "plugin:approval-1",
  status: "pending" as const,
  presentation: {
    kind: "plugin" as const,
    title: "Run Codex execution on node",
    description: "Allows node account access",
    severity: "critical" as const,
    pluginId: "codex",
    toolName: null,
    agentId: "main",
    allowedDecisions: ["allow-once", "deny"] as const,
  },
  urlPath: "/approve/plugin%3Aapproval-1",
  createdAtMs: 1_000,
  expiresAtMs: 10_000,
};

describe("session approval projection", () => {
  it("projects replay into the subscribed host session", () => {
    const queue = projectSessionApprovalReplay(
      {
        sessionKey: "agent:main:host",
        updatedAtMs: 2_000,
        approvals: [{ ...pendingPluginApproval, sourceSessionKey: "agent:main:cloud-child" }],
        truncated: false,
      },
      "agent:main:host",
    );

    expect(queue).toEqual([
      expect.objectContaining({
        id: "plugin:approval-1",
        kind: "plugin",
        pluginTitle: "Run Codex execution on node",
        sourceSessionKey: "agent:main:cloud-child",
        request: expect.objectContaining({ sessionKey: "agent:main:host" }),
      }),
    ]);
  });

  it("ignores malformed replay and live events", () => {
    expect(projectSessionApprovalReplay({ approvals: [{}] }, "agent:main:host")).toEqual([]);
    expect(reconcileSessionApprovalEvent([], { sessionKey: "agent:main:host" })).toBeNull();
  });

  it("ignores replay for a different session", () => {
    expect(
      projectSessionApprovalReplay(
        {
          sessionKey: "agent:main:other",
          updatedAtMs: 2_000,
          approvals: [pendingPluginApproval],
          truncated: false,
        },
        "agent:main:host",
      ),
    ).toEqual([]);
  });

  it("tracks the source session for a live ancestor projection and removes terminal state", () => {
    const pending = reconcileSessionApprovalEvent([], {
      sessionKey: "agent:main:host",
      sourceSessionKey: "agent:main:cloud-child",
      phase: "pending",
      updatedAtMs: 2_000,
      approval: pendingPluginApproval,
    });

    expect(pending).toEqual([
      expect.objectContaining({
        id: "plugin:approval-1",
        sourceSessionKey: "agent:main:cloud-child",
        request: expect.objectContaining({ sessionKey: "agent:main:host" }),
      }),
    ]);
    expect(
      reconcileSessionApprovalEvent(pending ?? [], {
        sessionKey: "agent:main:host",
        sourceSessionKey: "agent:main:cloud-child",
        phase: "terminal",
        updatedAtMs: 3_000,
        approval: {
          ...pendingPluginApproval,
          status: "denied",
          decision: "deny",
          reason: "user",
          resolvedAtMs: 3_000,
        },
      }),
    ).toEqual([]);
  });

  it("projects only the selected agent's qualified global approval stream", () => {
    const replay = {
      sessionKey: "agent:research:global",
      updatedAtMs: 2_000,
      approvals: [pendingPluginApproval],
      truncated: false,
    };
    expect(projectSessionApprovalReplay(replay, "global", "research")).toEqual([
      expect.objectContaining({
        id: "plugin:approval-1",
        request: expect.objectContaining({ sessionKey: "global" }),
      }),
    ]);
    expect(projectSessionApprovalReplay(replay, "global", "main")).toEqual([]);

    const event = {
      sessionKey: "agent:research:global",
      phase: "pending" as const,
      updatedAtMs: 2_000,
      approval: pendingPluginApproval,
    };
    expect(reconcileSessionApprovalEvent([], event, "global", "research")).toEqual([
      expect.objectContaining({
        id: "plugin:approval-1",
        request: expect.objectContaining({ sessionKey: "global" }),
      }),
    ]);
    expect(reconcileSessionApprovalEvent([], event, "global", "main")).toBeNull();
  });
});
