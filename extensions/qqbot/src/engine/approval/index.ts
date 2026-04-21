/**
 * Approval helpers — pure functions, zero framework dependencies.
 *
 * - Build approval message text + inline keyboard
 * - Resolve delivery target from session metadata
 * - Parse INTERACTION_CREATE button data
 */

import type { ChatScope, InlineKeyboard, KeyboardButton } from "../types.js";

// ============ Types ============

export interface ExecApprovalRequest {
  id: string;
  expiresAtMs: number;
  request: {
    commandPreview?: string;
    command?: string;
    cwd?: string;
    agentId?: string;
    turnSourceAccountId?: string;
    sessionKey?: string;
    turnSourceTo?: string;
    [key: string]: unknown;
  };
}

export interface PluginApprovalRequest {
  id: string;
  request: {
    timeoutMs?: number;
    severity?: string;
    title: string;
    description?: string;
    toolName?: string;
    pluginId?: string;
    agentId?: string;
    turnSourceAccountId?: string;
    sessionKey?: string;
    turnSourceTo?: string;
    [key: string]: unknown;
  };
}

export interface ExecApprovalResolved {
  id: string;
  decision: string;
  resolvedBy?: string;
  [key: string]: unknown;
}

export interface PluginApprovalResolved {
  id: string;
  decision: string;
  resolvedBy?: string;
  [key: string]: unknown;
}

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface ApprovalTarget {
  type: ChatScope;
  id: string;
}

export interface ParsedApprovalAction {
  approvalId: string;
  decision: ApprovalDecision;
}

// ============ Text Builders ============

export function buildExecApprovalText(request: ExecApprovalRequest): string {
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - Date.now()) / 1000));
  const lines: string[] = ["\u{1f510} \u547d\u4ee4\u6267\u884c\u5ba1\u6279", ""];
  const cmd = request.request.commandPreview ?? request.request.command ?? "";
  if (cmd) {
    lines.push(`\`\`\`\n${cmd.slice(0, 300)}\n\`\`\``);
  }
  if (request.request.cwd) {
    lines.push(`\u{1f4c1} \u76ee\u5f55: ${request.request.cwd}`);
  }
  if (request.request.agentId) {
    lines.push(`\u{1f916} Agent: ${request.request.agentId}`);
  }
  lines.push("", `\u23f1\ufe0f \u8d85\u65f6: ${expiresIn} \u79d2`);
  return lines.join("\n");
}

export function buildPluginApprovalText(request: PluginApprovalRequest): string {
  const timeoutSec = Math.round((request.request.timeoutMs ?? 120_000) / 1000);
  const severityIcon =
    request.request.severity === "critical"
      ? "\u{1f534}"
      : request.request.severity === "info"
        ? "\u{1f535}"
        : "\u{1f7e1}";

  const lines: string[] = [`${severityIcon} \u5ba1\u6279\u8bf7\u6c42`, ""];
  lines.push(`\u{1f4cb} ${request.request.title}`);
  if (request.request.description) {
    lines.push(`\u{1f4dd} ${request.request.description}`);
  }
  if (request.request.toolName) {
    lines.push(`\u{1f527} \u5de5\u5177: ${request.request.toolName}`);
  }
  if (request.request.pluginId) {
    lines.push(`\u{1f50c} \u63d2\u4ef6: ${request.request.pluginId}`);
  }
  if (request.request.agentId) {
    lines.push(`\u{1f916} Agent: ${request.request.agentId}`);
  }
  lines.push("", `\u23f1\ufe0f \u8d85\u65f6: ${timeoutSec} \u79d2`);
  return lines.join("\n");
}

// ============ Keyboard Builder ============

/**
 * Build the three-button inline keyboard for approval messages.
 *
 * type=1 (Callback): click triggers INTERACTION_CREATE, button_data = data field.
 * group_id "approval": clicking one button grays out the others (mutual exclusion).
 * click_limit=1: each user can only click once.
 * permission.type=2: all users can interact.
 */
export function buildApprovalKeyboard(
  approvalId: string,
  allowedDecisions: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"],
): InlineKeyboard {
  const makeBtn = (
    id: string,
    label: string,
    visitedLabel: string,
    data: string,
    style: 0 | 1,
  ): KeyboardButton => ({
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: {
      type: 1,
      data,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "approval",
  });

  const buttons: KeyboardButton[] = [];
  if (allowedDecisions.includes("allow-once")) {
    buttons.push(
      makeBtn(
        "allow",
        "\u2705 \u5141\u8bb8\u4e00\u6b21",
        "\u5df2\u5141\u8bb8",
        `approve:${approvalId}:allow-once`,
        1,
      ),
    );
  }
  if (allowedDecisions.includes("allow-always")) {
    buttons.push(
      makeBtn(
        "always",
        "\u2b50 \u59cb\u7ec8\u5141\u8bb8",
        "\u5df2\u59cb\u7ec8\u5141\u8bb8",
        `approve:${approvalId}:allow-always`,
        1,
      ),
    );
  }
  if (allowedDecisions.includes("deny")) {
    buttons.push(
      makeBtn("deny", "\u274c \u62d2\u7edd", "\u5df2\u62d2\u7edd", `approve:${approvalId}:deny`, 0),
    );
  }

  return {
    content: {
      rows: [
        {
          buttons,
        },
      ],
    },
  };
}

// ============ Target Resolver ============

/**
 * Extract the delivery target from a sessionKey or turnSourceTo string.
 *
 * Expected formats:
 *   agent:main:qqbot:direct:OPENID  -> { type: "c2c", id: "OPENID" }
 *   agent:main:qqbot:c2c:OPENID     -> { type: "c2c", id: "OPENID" }
 *   agent:main:qqbot:group:GROUPID  -> { type: "group", id: "GROUPID" }
 *
 * Returns null if neither field matches the expected pattern.
 */
export function resolveApprovalTarget(
  sessionKey: string | null | undefined,
  turnSourceTo: string | null | undefined,
): ApprovalTarget | null {
  const sk = sessionKey ?? turnSourceTo;
  if (!sk) {
    return null;
  }
  const m = sk.match(/qqbot:(c2c|direct|group):([A-F0-9]+)/i);
  if (!m) {
    return null;
  }
  const type: ChatScope = m[1].toLowerCase() === "group" ? "group" : "c2c";
  return { type, id: m[2] };
}

// ============ Interaction Parser ============

/**
 * Parse the button_data string from an INTERACTION_CREATE event.
 *
 * Expected format: `approve:<approvalId>:<decision>`
 * where approvalId may be prefixed with "exec:" or "plugin:".
 *
 * Returns null if the data does not match the approval button format.
 */
export function parseApprovalButtonData(buttonData: string): ParsedApprovalAction | null {
  const m = buttonData.match(
    /^approve:((?:(?:exec|plugin):)?[0-9a-f-]+):(allow-once|allow-always|deny)$/i,
  );
  if (!m) {
    return null;
  }
  return {
    approvalId: m[1],
    decision: m[2] as ApprovalDecision,
  };
}
