// Qqbot tests cover index plugin behavior.
import type { ExecApprovalPendingView } from "openclaw/plugin-sdk/approval-handler-runtime";
import { describe, expect, it } from "vitest";
import { buildApprovalKeyboard, buildExecApprovalText, parseApprovalButtonData } from "./index.js";

function createExecView(commandText: string): ExecApprovalPendingView {
  return {
    approvalId: "approval-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    metadata: [],
    commandText,
    actions: [],
    expiresAtMs: Date.now() + 60_000,
  };
}

function readCommandBlock(text: string): { body: string; fence: string } {
  const match = text.match(/(?:^|\n)(`{3,})\n([\s\S]*?)\n\1(?:\n|$)/);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error("Expected fenced command preview");
  }
  return { fence: match[1], body: match[2] };
}

describe("buildApprovalKeyboard", () => {
  it("omits allow-always when the decision is unavailable", () => {
    const keyboard = buildApprovalKeyboard("approval-123", "exec", ["allow-once", "deny"]);
    const buttons = keyboard.content.rows[0]?.buttons ?? [];

    expect(buttons.map((button) => button.id)).toEqual(["allow", "deny"]);
    expect(buttons.map((button) => button.action.data)).toEqual([
      "approve:v2:exec:approval-123:allow-once",
      "approve:v2:exec:approval-123:deny",
    ]);
    expect(buttons.map((button) => button.render_data.visited_label)).toEqual([
      "\u5df2\u5904\u7406",
      "\u5df2\u5904\u7406",
    ]);
  });

  it("keeps all buttons when all decisions are allowed", () => {
    const keyboard = buildApprovalKeyboard("approval-123", "plugin", [
      "allow-once",
      "allow-always",
      "deny",
    ]);
    const buttons = keyboard.content.rows[0]?.buttons ?? [];

    expect(buttons.map((button) => button.id)).toEqual(["allow", "always", "deny"]);
    expect(buttons.map((button) => button.render_data.visited_label)).toEqual([
      "\u5df2\u5904\u7406",
      "\u5df2\u5904\u7406",
      "\u5df2\u5904\u7406",
    ]);
  });

  it("round-trips an opaque id with an explicit kind", () => {
    const keyboard = buildApprovalKeyboard("exec:looks-like-exec/1", "plugin", ["deny"]);
    const data = keyboard.content.rows[0]?.buttons[0]?.action.data ?? "";

    expect(parseApprovalButtonData(data)).toEqual({
      approvalId: "exec:looks-like-exec/1",
      approvalKind: "plugin",
      decision: "deny",
    });
  });

  it("rejects legacy button data without an explicit kind", () => {
    expect(parseApprovalButtonData("approve:plugin:abc:deny")).toBeNull();
  });

  it.each([
    "Approve:v2:exec:approval-123:deny",
    "approve:V2:exec:approval-123:deny",
    "approve:v2:EXEC:approval-123:deny",
    "approve:v2:exec:approval-123:DENY",
  ])("rejects non-canonical uppercase envelope tokens: %s", (buttonData) => {
    expect(parseApprovalButtonData(buttonData)).toBeNull();
  });

  it("rejects data after an otherwise valid envelope", () => {
    expect(parseApprovalButtonData("approve:v2:exec:approval-123:deny\n")).toBeNull();
  });
});

describe("buildExecApprovalText", () => {
  it("keeps a truncated command UTF-16 well formed", () => {
    const safePrefix = "x".repeat(299);
    const text = buildExecApprovalText(createExecView(`${safePrefix}🎉 trailing text`));
    const { body } = readCommandBlock(text);

    expect(body.replace(/[↩\n]/g, "")).toBe(`${safePrefix}…[truncated]`);
    expect(body).not.toContain("🎉");
  });

  it("wraps ASCII and double-width text after 24 graphemes", () => {
    const ascii = readCommandBlock(buildExecApprovalText(createExecView("x".repeat(25))));
    const wide = readCommandBlock(buildExecApprovalText(createExecView(`${"表".repeat(24)}😀`)));

    expect(ascii.body).toBe(`${"x".repeat(24)}↩\nx`);
    expect(wide.body).toBe(`${"表".repeat(24)}↩\n😀`);
  });

  it("keeps an extended emoji grapheme intact at the 300-unit cap", () => {
    const family = "👨‍👩‍👧‍👦";
    const command = `${"x".repeat(289)}${family}`;
    const { body } = readCommandBlock(buildExecApprovalText(createExecView(command)));

    expect(body.replace(/[↩\n]/g, "")).toBe(command);
  });

  it("shows a truncation marker when the first grapheme exceeds the cap", () => {
    const oversizedGrapheme = `x${"\u0301".repeat(300)}`;
    const { body } = readCommandBlock(
      buildExecApprovalText(createExecView(`${oversizedGrapheme}; echo hidden`)),
    );

    expect(body.replace(/[↩\n]/g, "")).toBe(`${oversizedGrapheme.slice(0, 300)}…[truncated]`);
  });

  it("marks a display wrap before a shell comment boundary", () => {
    const command = `${"x".repeat(22)} \\# harmless ; echo dangerous`;
    const text = buildExecApprovalText(createExecView(command));
    const { body } = readCommandBlock(text);

    expect(text).toContain("↩ = display wrap only; not command text");
    expect(body).toContain(" \\↩\n# harmless ; echo danger↩\nous");
    expect(body.replace(/[↩\n]/g, "")).toBe(command);
  });

  it("uses a longer fence when the command contains triple backticks", () => {
    const command = "echo ```danger```";
    const { body, fence } = readCommandBlock(buildExecApprovalText(createExecView(command)));

    expect(fence).toBe("````");
    expect(body).toBe(command);
  });

  it("reserves the display-wrap marker", () => {
    const { body } = readCommandBlock(buildExecApprovalText(createExecView("echo ↩")));

    expect(body).toBe("echo \\u{21A9}");
  });
});
