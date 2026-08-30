// Telegram renders progress lines from their structured fields, so a line that
// arrives without detail falls back to text that already carries its icon.
import { buildChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

function renderToolLine(name: string) {
  const line = buildChannelProgressDraftLine(
    {
      event: "tool",
      toolCallId: "call-1",
      name,
      phase: "start",
      args: { command: "echo alpha", description: "print text" },
    },
    { commandText: "raw" },
  );
  if (!line) {
    throw new Error(`expected a progress line for ${name}`);
  }
  return renderTelegramProgressDraftPreview("Working", [line], false, true).text;
}

describe("renderTelegramProgressDraftPreview", () => {
  it("prints one tool icon per line for every backend spelling", () => {
    for (const name of ["Bash", "bash", "exec"]) {
      const rendered = renderToolLine(name);
      expect(rendered.match(/🛠️/gu) ?? []).toHaveLength(1);
    }
  });

  it("keeps the label and detail separate for a non-shell tool", () => {
    const line = buildChannelProgressDraftLine({
      event: "tool",
      toolCallId: "call-1",
      name: "Read",
      phase: "start",
      args: { file_path: "/tmp/x.ts" },
    });
    if (!line) {
      throw new Error("expected a progress line for Read");
    }

    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true).text;

    expect(rendered).toContain("<b>📖 Read</b>");
    expect(rendered.match(/📖/gu) ?? []).toHaveLength(1);
  });

  it("honors a configured budget and cuts prose on word boundaries", () => {
    const line = {
      kind: "item" as const,
      label: "Commentary",
      text: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
      prefix: false,
    };

    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true, 24).text;

    expect(rendered).toContain("alpha beta gamma…");
    expect(rendered).not.toContain("epsilon");
  });

  it("keeps command detail prefixes and useful path suffixes", () => {
    const path = `path/to/${"nested/".repeat(20)}file.ts`;
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name: "Bash",
        phase: "start",
        args: { command: `cat ${path}` },
      },
      { commandText: "raw" },
    );
    if (!line) {
      throw new Error("expected a progress line for Bash");
    }

    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true, 60).text;

    expect(rendered).toContain("<b>🛠️ Bash</b>");
    // The tail of the path carries the information; keep it visible.
    expect(rendered).toMatch(/…[^<]*file\.ts<\/code>/u);
  });

  it("bounds the bold status headline with the configured budget", () => {
    const narration = "I am checking whether the generated video exists after the render finished";

    const rendered = renderTelegramProgressDraftPreview(
      `${narration}\n\n✅ Inspect\n▸ Patch`,
      [],
      false,
      true,
      24,
    ).text;

    const bold = rendered.match(/<b>([^<]*)<\/b>/u)?.[1] ?? "";
    expect(bold).toBe("I am checking whether…");
    expect(rendered).toContain("✅ Inspect");
    expect(rendered).not.toContain("video");
  });

  it("bounds the rich status headline with the configured budget", () => {
    const narration = "I am checking whether the generated video exists after the render finished";

    const preview = renderTelegramProgressDraftPreview(
      `${narration}\n\n✅ Inspect`,
      [],
      true,
      true,
      24,
    );

    expect(preview.text).toContain("I am checking whether…");
    expect(preview.text).not.toContain("video");
    expect(JSON.stringify(preview.richMessage)).toContain("I am checking whether…");
    expect(JSON.stringify(preview.richMessage)).not.toContain("video");
  });

  it("keeps the status tail inside the composed line budget", () => {
    const path = `path/to/${"nested/".repeat(20)}file.ts`;
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name: "Bash",
        phase: "start",
        args: { command: `cat ${path}` },
      },
      { commandText: "raw" },
    );
    if (!line) {
      throw new Error("expected a progress line for Bash");
    }
    const statusLine = { ...line, status: "running" };

    const rendered = renderTelegramProgressDraftPreview(
      "Working",
      [statusLine],
      false,
      true,
      16,
    ).text;
    const toolLine = (rendered.split("<br>")[1] ?? "").replace(/<[^>]+>/gu, "");

    // label (8) + " " + status (7) already reaches 16, so the composed line
    // stays at budget instead of appending an unbounded detail.
    expect(Array.from(toolLine).length).toBeLessThanOrEqual(16);
    expect(toolLine).toContain("running");
  });

  it("omits the status when the label fills the configured budget", () => {
    const structured = (status: string) => ({
      kind: "item" as const,
      label: "Deploy check",
      text: "Deploy check",
      status,
      prefix: false,
    });

    // Label (12) exactly fills the budget: no room for the joining separator
    // plus status, so the status is omitted instead of overflowing the line.
    const atBudget = renderTelegramProgressDraftPreview(
      "Working",
      [structured("running")],
      false,
      true,
      12,
    ).text;
    const atBudgetLine = (atBudget.split("<br>")[1] ?? "").replace(/<[^>]+>/gu, "");
    expect(atBudgetLine).toBe("Deploy check");

    // One code point below the budget leaves only the separator: the status
    // still does not fit and stays omitted.
    const oneBelow = renderTelegramProgressDraftPreview(
      "Working",
      [structured("running")],
      false,
      true,
      13,
    ).text;
    const oneBelowLine = (oneBelow.split("<br>")[1] ?? "").replace(/<[^>]+>/gu, "");
    expect(oneBelowLine).toBe("Deploy check");

    // Two code points below the budget fit the separator plus one clipped
    // status character without exceeding the line budget.
    const withRoom = renderTelegramProgressDraftPreview(
      "Working",
      [structured("running")],
      false,
      true,
      15,
    ).text;
    const withRoomLine = (withRoom.split("<br>")[1] ?? "").replace(/<[^>]+>/gu, "");
    expect(Array.from(withRoomLine).length).toBeLessThanOrEqual(15);
    expect(withRoomLine).toContain("…");
  });

  it("keeps the label and fallback detail within one line budget", () => {
    const path = `path/to/${"nested/".repeat(20)}file.ts`;
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name: "Bash",
        phase: "start",
        args: { command: `cat ${path}` },
      },
      { commandText: "raw" },
    );
    if (!line) {
      throw new Error("expected a progress line for Bash");
    }

    // A valid budget shorter than the label plus the canonical compactor's
    // eight-character detail minimum must still bound the composed line.
    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true, 12).text;
    const toolLine = (rendered.split("<br>")[1] ?? "").replace(/<[^>]+>/gu, "");

    expect(Array.from(toolLine).length).toBeLessThanOrEqual(12);
    expect(toolLine).toContain("Bash");
    expect(toolLine).toContain("…");
  });

  it("keeps the historical 300 budget when no budget is passed", () => {
    const line = {
      kind: "item" as const,
      label: "Commentary",
      text: `${"x ".repeat(150)}tail`,
      prefix: false,
    };

    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true).text;

    expect(rendered).toContain("…");
    expect(rendered).not.toContain("tail");
  });
});
