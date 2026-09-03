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
  it("nests workflow details beneath the active plan step in every preview format", () => {
    const lines = ["exec", "Read"].map((name, index) => {
      const line = buildChannelProgressDraftLine(
        {
          event: "tool",
          toolCallId: `call-${index + 1}`,
          name,
          phase: "start",
          args: name === "exec" ? { command: "echo alpha" } : { file_path: "/tmp/x.ts" },
        },
        { commandText: "raw" },
      );
      if (!line) {
        throw new Error(`expected a progress line for ${name}`);
      }
      return line;
    });
    const status = "Implementing the change.\n\n✅ Inspect\n▸ Patch\n▢ Test";

    const planLayout = { lineCount: 3, activeLineIndex: 1 };
    const html = renderTelegramProgressDraftPreview(status, lines, false, true, planLayout);
    const rich = renderTelegramProgressDraftPreview(status, lines, true, true, planLayout);

    expect(html.text).toMatch(/▸ Patch<br>↳ .*Exec.*<br>↳ .*Read.*<br>▢ Test/u);
    expect(rich.text).toMatch(/▸ Patch\n↳ 🛠️ .*\n↳ 📖 .*\n▢ Test/u);
    expect(JSON.stringify(rich.richMessage)).toContain("↳ ");
  });

  it("keeps unplanned progress flat", () => {
    const line = buildChannelProgressDraftLine({
      event: "tool",
      toolCallId: "call-1",
      name: "exec",
      phase: "start",
    });
    if (!line) {
      throw new Error("expected a progress line for exec");
    }

    expect(renderTelegramProgressDraftPreview("Working", [line], false, true).text).toBe(
      "Working<br><b>🛠️ Exec</b>",
    );
  });

  it("uses structured plan layout when authored text begins with the active marker", () => {
    const line = buildChannelProgressDraftLine({
      event: "tool",
      toolCallId: "call-1",
      name: "Read",
      phase: "start",
    });
    if (!line) {
      throw new Error("expected a progress line for Read");
    }

    const active = renderTelegramProgressDraftPreview(
      "▸ authored headline\n\n✅ Inspect\n▸ Patch\n▢ Test",
      [line],
      false,
      true,
      { lineCount: 3, activeLineIndex: 1 },
    );
    expect(active.text).toMatch(/✅ Inspect<br>▸ Patch<br>↳ .*Read.*<br>▢ Test/u);

    const pendingOnly = renderTelegramProgressDraftPreview(
      "▸ authored headline\n\n▢ Patch",
      [line],
      false,
      true,
      { lineCount: 1 },
    );
    expect(pendingOnly.text).toBe("<b>▸ authored headline</b><br>▢ Patch<br><b>📖 Read</b>");
  });

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
});
