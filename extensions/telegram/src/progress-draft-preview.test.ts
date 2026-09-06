import {
  buildChannelProgressDraftLine,
  type ChannelProgressDraftCompositorSnapshot,
} from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { telegramHtmlToPlainTextFallback } from "./format.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

const options = { richMessages: false, maxLines: 8, maxLineChars: 300 };

describe("renderTelegramProgressDraftPreview", () => {
  it.each(["Bash", "bash", "exec", "Read"])("prints one tool icon for %s", (name) => {
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name,
        phase: "start",
        args: { command: "echo alpha", description: "print text", file_path: "/tmp/x.ts" },
      },
      { commandText: "raw" },
    );
    if (!line?.icon) {
      throw new Error(`expected an icon for ${name}`);
    }
    const preview = renderTelegramProgressDraftPreview({ lines: [line] }, options);
    expect(preview.text.split(line.icon)).toHaveLength(2);
    expect(preview.text).toContain(`<b>${line.icon} ${line.label}</b>`);
  });

  it("renders native checkboxes and equivalent readable HTML from the same plan", () => {
    const snapshot: ChannelProgressDraftCompositorSnapshot = {
      lines: [],
      statusHeadline: "1/3 complete",
      plan: [
        { step: "Inspect <fixture>", status: "completed" },
        { step: "Repair & verify", status: "in_progress" },
        { step: "Ship the fix", status: "pending" },
      ],
    };
    const rich = renderTelegramProgressDraftPreview(snapshot, { ...options, richMessages: true });
    const html = renderTelegramProgressDraftPreview(snapshot, options);
    expect(rich.richMessage?.blocks).toEqual([
      { type: "paragraph", text: { type: "bold", text: "1/3 complete" } },
      {
        type: "list",
        items: [
          {
            has_checkbox: true,
            is_checked: true,
            blocks: [{ type: "paragraph", text: "Inspect <fixture>" }],
          },
          {
            has_checkbox: true,
            blocks: [
              { type: "paragraph", text: { type: "bold", text: "Repair & verify (in progress)" } },
            ],
          },
          { has_checkbox: true, blocks: [{ type: "paragraph", text: "Ship the fix" }] },
        ],
      },
    ]);
    expect(telegramHtmlToPlainTextFallback(html.text)).toBe(rich.text);
    expect(html.text).not.toContain("<code>");
    expect(html.text).toContain("Inspect &lt;fixture&gt;");
    expect(html.complete).toBe(true);
    expect(rich.complete).toBe(true);
  });

  it("keeps attention and the active step within the configured window", () => {
    const preview = renderTelegramProgressDraftPreview(
      {
        lines: [
          { kind: "tool", label: "Read", text: "Read files" },
          { kind: "approval", label: "Approval", text: "Approval", detail: "Confirm access" },
        ],
        diffStat: { files: 1, added: 2, removed: 1 },
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Repair", status: "in_progress" },
          { step: "Verify", status: "pending" },
          { step: "Ship", status: "pending" },
        ],
      },
      { ...options, richMessages: true, maxLines: 3 },
    );
    expect(preview.text.split("\n")).toHaveLength(3);
    expect(preview.text).toContain("Confirm access");
    expect(preview.text).toContain("Repair (in progress)");
    expect(preview.text).toContain("1/4 done");
    expect(preview.text).not.toContain("Read files");
  });
  it.each([true, false])(
    "renders retained edit totals without a plan (rich=%s)",
    (richMessages) => {
      const preview = renderTelegramProgressDraftPreview(
        { lines: [], diffStat: { files: 1, added: 2, removed: 1 } },
        { ...options, richMessages },
      );
      expect(telegramHtmlToPlainTextFallback(preview.text)).toBe("📝 1 files +2 −1");
      expect(preview.text).not.toContain("<code>");
    },
  );
});
