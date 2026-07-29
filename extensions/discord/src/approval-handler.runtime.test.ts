// Discord tests cover approval handler plugin behavior.
import { describe, expect, it } from "vitest";
import { discordApprovalNativeRuntime } from "./approval-handler.runtime.js";

async function buildExecApprovalPayloadText(commandText: string): Promise<string> {
  const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
    cfg: {} as never,
    accountId: "main",
    context: {
      token: "discord-token",
      config: {} as never,
    },
    request: {
      id: "approval-1",
      request: {
        command: commandText,
      },
      createdAtMs: 0,
      expiresAtMs: 1_000,
    },
    approvalKind: "exec",
    nowMs: 0,
    view: {
      approvalKind: "exec",
      phase: "pending",
      approvalId: "approval-1",
      title: "Exec Approval Required",
      commandText,
      commandPreview: null,
      expiresAtMs: 1_000,
      metadata: [],
      actions: [
        {
          label: "Allow",
          decision: "allow-once",
          style: "success",
          command: "/approve approval-1 allow-once",
          action: {
            type: "approval",
            approvalId: "approval-1",
            approvalKind: "exec",
            decision: "allow-once",
          },
        },
      ],
    },
  });
  return JSON.stringify(pending);
}

async function buildPluginApprovalPayloadText(): Promise<string> {
  const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
    cfg: {} as never,
    accountId: "main",
    context: {
      token: "discord-token",
      config: {} as never,
    },
    request: {
      id: "plain-plugin-id",
      request: {
        title: "Install plugin",
        description: "Approve the requested plugin",
      },
      createdAtMs: 0,
      expiresAtMs: 1_000,
    },
    approvalKind: "plugin",
    nowMs: 0,
    view: {
      approvalKind: "plugin",
      phase: "pending",
      approvalId: "plain-plugin-id",
      title: "Install plugin",
      description: "Approve the requested plugin",
      severity: "warning",
      pluginId: "example-plugin",
      toolName: "plugin.install",
      metadata: [],
      actions: [
        {
          label: "Deny",
          decision: "deny",
          style: "danger",
          command: "/approve plain-plugin-id deny",
          action: {
            type: "approval",
            approvalId: "plain-plugin-id",
            approvalKind: "plugin",
            decision: "deny",
          },
        },
      ],
      expiresAtMs: 1_000,
    },
  } as never);
  return JSON.stringify(pending);
}

describe("discordApprovalNativeRuntime", () => {
  it("keeps create-only nonce fields out of the shared multi-target payload", async () => {
    const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "main",
      context: { token: "discord-token", config: {} as never },
      request: {
        id: "approval-1",
        request: { command: "hostname" },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        phase: "pending",
        approvalId: "approval-1",
        title: "Exec Approval Required",
        commandText: "hostname",
        commandPreview: null,
        expiresAtMs: 1_000,
        metadata: [],
        actions: [],
      },
    });

    expect(pending.body).not.toHaveProperty("nonce");
    expect(pending.body).not.toHaveProperty("enforce_nonce");
  });

  it("encodes the explicit owner kind in exec and plugin approval buttons", async () => {
    const execPayload = await buildExecApprovalPayloadText("hostname");
    expect(execPayload).toContain("execapproval:kind=exec;id=approval-1;action=allow-once");
    expect(execPayload).toContain('"allowed_mentions":{"parse":[]}');
    await expect(buildPluginApprovalPayloadText()).resolves.toContain(
      "execapproval:kind=plugin;id=plain-plugin-id;action=deny",
    );
  });

  it("does not split emoji graphemes when truncating exec command previews", async () => {
    const prefix = "a".repeat(999);

    await expect(buildExecApprovalPayloadText(`${prefix}😀x`)).resolves.toContain(`${prefix}...`);
    await expect(buildExecApprovalPayloadText(`${prefix}🇺🇸x`)).resolves.toContain(`${prefix}...`);
  });

  it("routes origin approval updates to the Discord thread channel when threadId is present", async () => {
    const prepared = await discordApprovalNativeRuntime.transport.prepareTarget({
      cfg: {} as never,
      accountId: "main",
      context: {
        token: "discord-token",
        config: {} as never,
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "123456789",
          threadId: "777888999",
        },
      },
      request: {
        id: "req-1",
        request: {
          command: "hostname",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      view: {} as never,
      pendingPayload: {} as never,
    });

    expect(prepared).toEqual({
      dedupeKey: "777888999",
      target: {
        discordChannelId: "777888999",
      },
    });
  });
});
