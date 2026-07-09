// Qqbot tests cover native approval presentation behavior.
import type {
  ExecApprovalPendingView,
  PluginApprovalPendingView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/approval-runtime";
import { describe, expect, it } from "vitest";
import type { InlineKeyboard } from "../../engine/types.js";
import { qqbotApprovalNativeRuntime } from "./handler-runtime.js";

type QQBotPendingPayload = {
  text: string;
  keyboard: InlineKeyboard;
};

function createExecView(commandText: string): ExecApprovalPendingView {
  return {
    approvalId: "approval-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    metadata: [],
    commandText,
    commandPreview: "short preview",
    actions: [
      {
        decision: "allow-once",
        label: "Allow Once",
        command: "/approve approval-1 allow-once",
        style: "success",
      },
      {
        decision: "deny",
        label: "Deny",
        command: "/approve approval-1 deny",
        style: "danger",
      },
    ],
    expiresAtMs: Date.now() + 60_000,
  };
}

function createPluginView(expiresAtMs: number): PluginApprovalPendingView {
  return {
    approvalId: "plugin:approval-1",
    approvalKind: "plugin",
    phase: "pending",
    title: "Install plugin",
    description: "Approve the requested plugin",
    metadata: [],
    pluginId: "example-plugin",
    toolName: "plugin.install",
    agentId: "main",
    severity: "critical",
    actions: [
      {
        decision: "allow-once",
        label: "Allow Once",
        command: "/approve plugin:approval-1 allow-once",
        style: "success",
      },
      {
        decision: "deny",
        label: "Deny",
        command: "/approve plugin:approval-1 deny",
        style: "danger",
      },
    ],
    expiresAtMs,
  };
}

describe("qqbotApprovalNativeRuntime", () => {
  it("renders the sanitized primary command with callback buttons", async () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const rawCommand = `printf '${secret}\u200b'\n你好😀`;
    const commandText = resolveExecApprovalCommandDisplay({ command: rawCommand }).commandText;
    const view = createExecView(commandText);
    view.cwd = "/tmp\n![fake](u)";
    view.agentId = "agent```fake";
    const payload = (await qqbotApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {},
      request: {
        id: "approval-1",
        request: { command: rawCommand, commandPreview: "short preview" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    })) as QQBotPendingPayload;

    expect(commandText).not.toContain(secret);
    expect(commandText).toContain("\\u{200B}");
    expect(commandText).toContain("\\u{A}");
    expect(commandText).toContain("你好😀");
    expect(payload.text.replace(/[↩\n]/g, "")).toContain(commandText);
    expect(payload.text).not.toContain(secret);
    expect(payload.text).not.toContain("short preview");
    expect(payload.text).not.toContain("/tmp\n![fake]");
    expect(payload.text).toContain("📁 目录:\n```\n/tmp\\u{A}![fake](u)\n```");
    expect(payload.text).toContain("🤖 Agent:\n````\nagent```fake\n````");
    expect(payload.keyboard.content.rows[0]?.buttons.map((button) => button.action.data)).toEqual([
      "approve:approval-1:allow-once",
      "approve:approval-1:deny",
    ]);
  });

  it("renders a plugin approval's actual remaining lifetime", async () => {
    const nowMs = 1_000_000;
    const view = createPluginView(nowMs + 600_000);
    const payload = (await qqbotApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {},
      request: {
        id: view.approvalId,
        request: {
          title: "stale raw title",
          description: "stale raw description",
          severity: "info",
        },
        createdAtMs: nowMs,
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "plugin",
      nowMs,
      view,
    })) as QQBotPendingPayload;

    expect(payload.text).toContain("🔴 审批请求");
    expect(payload.text).toContain("📋 Install plugin");
    expect(payload.text).toContain("📝 Approve the requested plugin");
    expect(payload.text).not.toContain("stale raw");
    expect(payload.text).toContain("⏱️ 超时: 600 秒");
    expect(payload.keyboard.content.rows[0]?.buttons.map((button) => button.action.data)).toEqual([
      "approve:plugin:approval-1:allow-once",
      "approve:plugin:approval-1:deny",
    ]);
  });
});
