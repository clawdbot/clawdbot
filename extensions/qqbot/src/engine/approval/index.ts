/**
 * Approval helpers — pure functions, zero framework dependencies.
 *
 * - Build approval message text + inline keyboard
 * - Resolve delivery target from session metadata
 * - Parse INTERACTION_CREATE button data
 */

import type {
  ExecApprovalPendingView,
  PluginApprovalPendingView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/approval-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
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

type ApprovalDecision = "allow-once" | "allow-always" | "deny";
type ApprovalKind = "exec" | "plugin";

interface ApprovalTarget {
  type: ChatScope;
  id: string;
}

interface ParsedApprovalAction {
  approvalId: string;
  approvalKind: ApprovalKind;
  decision: ApprovalDecision;
}

// ============ Text Builders ============

const COMMAND_PREVIEW_MAX_LENGTH = 300;
const COMMAND_PREVIEW_GRAPHEMES_PER_LINE = 24;
const COMMAND_PREVIEW_WRAP_MARKER = "↩";
const commandPreviewSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function splitCommandPreviewGraphemes(commandText: string): string[] {
  return commandPreviewSegmenter
    ? Array.from(commandPreviewSegmenter.segment(commandText), ({ segment }) => segment)
    : Array.from(commandText);
}

function formatCommandPreview(commandText: string): string {
  // QQ Desktop does not wrap fenced blocks. The sanitized view has already escaped real command
  // newlines, so these grapheme-safe line breaks are presentation-only and unambiguous. Limiting
  // each line to 24 graphemes also bounds common double-width text to roughly 48 columns.
  const lines = [""];
  const displayText = commandText.replaceAll(COMMAND_PREVIEW_WRAP_MARKER, "\\u{21A9}");
  let previewLength = 0;
  let lineGraphemes = 0;
  let truncated = false;
  let wrapped = false;
  for (const grapheme of splitCommandPreviewGraphemes(displayText)) {
    if (previewLength + grapheme.length > COMMAND_PREVIEW_MAX_LENGTH) {
      // A pathological first grapheme cannot fit intact; keep a visible UTF-16-safe prefix instead
      // of presenting an empty command with active approval buttons.
      if (previewLength === 0) {
        lines[0] = truncateUtf16Safe(grapheme, COMMAND_PREVIEW_MAX_LENGTH);
      }
      truncated = true;
      break;
    }
    previewLength += grapheme.length;
    if (lineGraphemes === COMMAND_PREVIEW_GRAPHEMES_PER_LINE) {
      lines[lines.length - 1] += COMMAND_PREVIEW_WRAP_MARKER;
      lines.push("");
      lineGraphemes = 0;
      wrapped = true;
    }
    lines[lines.length - 1] += grapheme;
    lineGraphemes += 1;
  }
  const preview = `${lines.join("\n")}${truncated ? "\n…[truncated]" : ""}`;
  const longestBacktickRun = Math.max(0, ...(preview.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const block = `${fence}\n${preview}\n${fence}`;
  return wrapped
    ? `${COMMAND_PREVIEW_WRAP_MARKER} = display wrap only; not command text\n${block}`
    : block;
}

function formatApprovalMetadata(value: string): string {
  const sanitized = resolveExecApprovalCommandDisplay({ command: value }).commandText;
  return formatCommandPreview(sanitized);
}

export function buildExecApprovalText(view: ExecApprovalPendingView, nowMs = Date.now()): string {
  const expiresIn = Math.max(0, Math.round((view.expiresAtMs - nowMs) / 1000));
  const lines: string[] = ["\u{1f510} \u547d\u4ee4\u6267\u884c\u5ba1\u6279", ""];
  if (view.commandText) {
    lines.push(formatCommandPreview(view.commandText));
  }
  if (view.cwd) {
    lines.push(`\u{1f4c1} \u76ee\u5f55:\n${formatApprovalMetadata(view.cwd)}`);
  }
  if (view.agentId) {
    lines.push(`\u{1f916} Agent:\n${formatApprovalMetadata(view.agentId)}`);
  }
  lines.push("", `\u23f1\ufe0f \u8d85\u65f6: ${expiresIn} \u79d2`);
  return lines.join("\n");
}

export function buildPluginApprovalText(
  view: PluginApprovalPendingView,
  nowMs = Date.now(),
): string {
  const expiresIn = Math.max(0, Math.round((view.expiresAtMs - nowMs) / 1000));
  const severityIcon =
    view.severity === "critical"
      ? "\u{1f534}"
      : view.severity === "info"
        ? "\u{1f535}"
        : "\u{1f7e1}";

  const lines: string[] = [`${severityIcon} \u5ba1\u6279\u8bf7\u6c42`, ""];
  lines.push(`\u{1f4cb} ${view.title}`);
  if (view.description) {
    lines.push(`\u{1f4dd} ${view.description}`);
  }
  if (view.toolName) {
    lines.push(`\u{1f527} \u5de5\u5177: ${view.toolName}`);
  }
  if (view.pluginId) {
    lines.push(`\u{1f50c} \u63d2\u4ef6: ${view.pluginId}`);
  }
  if (view.agentId) {
    lines.push(`\u{1f916} Agent: ${view.agentId}`);
  }
  lines.push("", `\u23f1\ufe0f \u8d85\u65f6: ${expiresIn} \u79d2`);
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
  approvalKind: ApprovalKind,
  allowedDecisions: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"],
): InlineKeyboard {
  const actionPrefix = `approve:v2:${approvalKind}:${encodeURIComponent(approvalId)}`;
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
        "\u5df2\u5904\u7406",
        `${actionPrefix}:allow-once`,
        1,
      ),
    );
  }
  if (allowedDecisions.includes("allow-always")) {
    buttons.push(
      makeBtn(
        "always",
        "\u2b50 \u59cb\u7ec8\u5141\u8bb8",
        "\u5df2\u5904\u7406",
        `${actionPrefix}:allow-always`,
        1,
      ),
    );
  }
  if (allowedDecisions.includes("deny")) {
    buttons.push(
      makeBtn("deny", "\u274c \u62d2\u7edd", "\u5df2\u5904\u7406", `${actionPrefix}:deny`, 0),
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
  const scope = m[1];
  const id = m[2];
  if (scope === undefined || id === undefined) {
    return null;
  }
  const type: ChatScope = scope.toLowerCase() === "group" ? "group" : "c2c";
  return { type, id };
}

// ============ Interaction Parser ============

/**
 * Parse the button_data string from an INTERACTION_CREATE event.
 *
 * Expected format: `approve:v2:<approvalKind>:<encodedApprovalId>:<decision>`.
 *
 * Returns null if the data does not match the approval button format.
 */
export function parseApprovalButtonData(buttonData: string): ParsedApprovalAction | null {
  const m = buttonData.match(/^approve:v2:(exec|plugin):([^:]+):(allow-once|allow-always|deny)$/);
  if (!m || m[0] !== buttonData) {
    return null;
  }
  let approvalId: string;
  const kind = m[1];
  const encodedId = m[2];
  const decision = m[3];
  if (
    (kind !== "exec" && kind !== "plugin") ||
    encodedId === undefined ||
    (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny")
  ) {
    return null;
  }
  try {
    approvalId = decodeURIComponent(encodedId);
  } catch {
    return null;
  }
  if (!approvalId) {
    return null;
  }
  return {
    approvalId,
    approvalKind: kind,
    decision,
  };
}
