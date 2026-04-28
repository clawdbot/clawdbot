import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixApprovalNativeRuntime } from "./approval-handler.runtime.js";
import {
  clearMatrixApprovalReactionTargetsForTest,
  resolveMatrixApprovalReactionTarget,
} from "./approval-reactions.js";

type MatrixDeliverPendingParams = Parameters<
  typeof matrixApprovalNativeRuntime.transport.deliverPending
>[0];
type MatrixPendingApprovalView = MatrixDeliverPendingParams["view"];
type MatrixPendingExecApprovalView = Extract<MatrixPendingApprovalView, { approvalKind: "exec" }>;
type MatrixPendingPluginApprovalView = Extract<
  MatrixPendingApprovalView,
  { approvalKind: "plugin" }
>;

const MATRIX_APPROVAL_METADATA_KEY = "com.openclaw.approval";

function buildMatrixApprovalRoomTarget(
  roomId: string,
): MatrixDeliverPendingParams["plannedTarget"] {
  return {
    surface: "approver-dm",
    target: {
      to: `room:${roomId}`,
    },
    reason: "preferred",
  };
}

function buildExecApprovalView(
  overrides: Partial<MatrixPendingExecApprovalView> = {},
): MatrixPendingExecApprovalView {
  return {
    approvalKind: "exec",
    approvalId: "req-1",
    phase: "pending",
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    metadata: [],
    ask: "on-request",
    agentId: "agent-1",
    commandText: "echo hi",
    commandPreview: "echo hi",
    cwd: "/repo",
    host: "gateway",
    actions: [
      {
        decision: "allow-once",
        label: "Allow Once",
        style: "success",
        command: "/approve req-1 allow-once",
      },
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve req-1 deny",
      },
    ],
    expiresAtMs: 1_000,
    ...overrides,
  };
}

function buildPluginApprovalView(
  overrides: Partial<MatrixPendingPluginApprovalView> = {},
): MatrixPendingPluginApprovalView {
  return {
    approvalKind: "plugin",
    approvalId: "plugin:req-1",
    phase: "pending",
    title: "Plugin Approval Required",
    description: "Approve the tool call.",
    metadata: [],
    agentId: "agent-1",
    pluginId: "ops",
    toolName: "deploy",
    severity: "critical",
    actions: [
      {
        decision: "allow-once",
        label: "Allow Once",
        style: "success",
        command: "/approve plugin:req-1 allow-once",
      },
    ],
    expiresAtMs: 1_000,
    ...overrides,
  };
}

async function buildPendingPayload(view: MatrixPendingApprovalView) {
  const request =
    view.approvalKind === "plugin"
      ? ({
          id: view.approvalId,
          request: {
            title: view.title,
            description: view.description ?? "",
            severity: view.severity,
            toolName: view.toolName ?? undefined,
            pluginId: view.pluginId ?? undefined,
            agentId: view.agentId ?? undefined,
          },
          createdAtMs: 0,
          expiresAtMs: view.expiresAtMs,
        } satisfies PluginApprovalRequest)
      : ({
          id: view.approvalId,
          request: {
            command: view.commandText,
            cwd: view.cwd ?? undefined,
            host: view.host ?? undefined,
            agentId: view.agentId ?? undefined,
          },
          createdAtMs: 0,
          expiresAtMs: view.expiresAtMs,
        } satisfies ExecApprovalRequest);
  return await matrixApprovalNativeRuntime.presentation.buildPendingPayload({
    cfg: {} as never,
    accountId: "default",
    context: { client: {} as never },
    request,
    approvalKind: view.approvalKind,
    nowMs: 100,
    view,
  });
}

describe("matrixApprovalNativeRuntime", () => {
  beforeEach(() => {
    clearMatrixApprovalReactionTargetsForTest();
  });

  it("sends versioned Matrix approval content with pending exec approvals", async () => {
    const sendSingleTextMessage = vi.fn().mockResolvedValue({
      messageId: "$approval",
      primaryMessageId: "$approval",
      messageIds: ["$approval"],
      roomId: "!room:example.org",
    });
    const reactMessage = vi.fn().mockResolvedValue(undefined);
    const view = buildExecApprovalView();
    const pendingPayload = await buildPendingPayload(view);

    await matrixApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        client: {} as never,
        deps: {
          sendSingleTextMessage,
          reactMessage,
        },
      },
      request: {} as never,
      approvalKind: "exec",
      plannedTarget: buildMatrixApprovalRoomTarget("!room:example.org"),
      preparedTarget: {
        to: "room:!room:example.org",
        roomId: "!room:example.org",
      },
      view,
      pendingPayload,
    });

    expect(sendSingleTextMessage).toHaveBeenCalledWith(
      "room:!room:example.org",
      expect.stringContaining("echo hi"),
      expect.objectContaining({
        extraContent: {
          [MATRIX_APPROVAL_METADATA_KEY]: expect.objectContaining({
            version: 1,
            type: "approval.request",
            state: "pending",
            id: "req-1",
            kind: "exec",
            commandText: "echo hi",
            cwd: "/repo",
            agentId: "agent-1",
            allowedDecisions: ["allow-once", "deny"],
          }),
        },
      }),
    );
  });

  it("delivers Matrix approval content with plugin approval fields", async () => {
    const sendSingleTextMessage = vi.fn().mockResolvedValue({
      messageId: "$plugin-approval",
      primaryMessageId: "$plugin-approval",
      messageIds: ["$plugin-approval"],
      roomId: "!room:example.org",
    });
    const reactMessage = vi.fn().mockResolvedValue(undefined);
    const view = buildPluginApprovalView();
    const pendingPayload = await buildPendingPayload(view);

    await matrixApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        client: {} as never,
        deps: {
          sendSingleTextMessage,
          reactMessage,
        },
      },
      request: {} as never,
      approvalKind: "plugin",
      plannedTarget: buildMatrixApprovalRoomTarget("!room:example.org"),
      preparedTarget: {
        to: "room:!room:example.org",
        roomId: "!room:example.org",
      },
      view,
      pendingPayload,
    });

    expect(sendSingleTextMessage).toHaveBeenCalledWith(
      "room:!room:example.org",
      expect.stringContaining("deploy"),
      expect.objectContaining({
        extraContent: {
          [MATRIX_APPROVAL_METADATA_KEY]: {
            version: 1,
            type: "approval.request",
            state: "pending",
            phase: "pending",
            id: "plugin:req-1",
            kind: "plugin",
            title: "Plugin Approval Required",
            description: "Approve the tool call.",
            expiresAtMs: 1_000,
            metadata: [],
            allowedDecisions: ["allow-once"],
            actions: [
              {
                decision: "allow-once",
                label: "Allow Once",
                style: "success",
                command: "/approve plugin:req-1 allow-once",
              },
            ],
            pluginId: "ops",
            toolName: "deploy",
            agentId: "agent-1",
            severity: "critical",
          },
        },
      }),
    );
    expect(reactMessage).toHaveBeenCalledWith(
      "!room:example.org",
      "$plugin-approval",
      "✅",
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("falls back to chunked Matrix delivery when approval content exceeds one event", async () => {
    const sendSingleTextMessage = vi
      .fn()
      .mockRejectedValue(new Error("Matrix single-message text exceeds limit (5000 > 4000)"));
    const sendMessage = vi.fn().mockResolvedValue({
      messageId: "$last",
      primaryMessageId: "$primary",
      messageIds: ["$primary", "$last"],
      roomId: "!room:example.org",
    });
    const reactMessage = vi.fn().mockResolvedValue(undefined);
    const view = buildExecApprovalView({
      actions: [
        {
          decision: "allow-once",
          label: "Allow Once",
          style: "success",
          command: "/approve req-1 allow-once",
        },
      ],
    });
    const pendingPayload = await buildPendingPayload(view);

    const entry = await matrixApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        client: {} as never,
        deps: {
          sendSingleTextMessage,
          sendMessage,
          reactMessage,
        },
      },
      request: {} as never,
      approvalKind: "exec",
      plannedTarget: buildMatrixApprovalRoomTarget("!room:example.org"),
      preparedTarget: {
        to: "room:!room:example.org",
        roomId: "!room:example.org",
      },
      view,
      pendingPayload,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "room:!room:example.org",
      pendingPayload.text,
      expect.objectContaining({
        accountId: "default",
        extraContent: pendingPayload.extraContent,
      }),
    );
    expect(reactMessage).toHaveBeenCalledWith(
      "!room:example.org",
      "$primary",
      expect.any(String),
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(entry).toMatchObject({
      roomId: "!room:example.org",
      messageIds: ["$primary", "$last"],
      reactionEventId: "$primary",
    });
    const bindPending = matrixApprovalNativeRuntime.interactions?.bindPending;
    if (!bindPending) {
      throw new Error("Matrix approval runtime must expose bindPending");
    }
    const binding = await bindPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        client: {} as never,
      },
      request: {} as never,
      approvalKind: "exec",
      view,
      pendingPayload,
      entry: entry!,
    });

    expect(binding).toEqual({
      roomId: "!room:example.org",
      eventId: "$primary",
    });
    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!room:example.org",
        eventId: "$primary",
        reactionKey: "✅",
      }),
    ).toEqual({
      approvalId: "req-1",
      decision: "allow-once",
    });
    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!room:example.org",
        eventId: "$last",
        reactionKey: "✅",
      }),
    ).toBeNull();
  });

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
