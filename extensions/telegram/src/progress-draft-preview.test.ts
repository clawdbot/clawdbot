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

  it("renders only the plain sentence for plain-mode tool lines", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name: "web_search",
        phase: "start",
        args: { query: "openclaw docs" },
      },
      { detailMode: "plain" },
    );
    if (!line) {
      throw new Error("expected a progress line for plain mode");
    }

    for (const richMessages of [false, true]) {
      const rendered = renderTelegramProgressDraftPreview(
        "Working",
        [line],
        richMessages,
        true,
      ).text;
      expect(rendered).toContain(line.text);
      // No tool emoji and no tool-name label ahead of the sentence.
      expect(rendered).not.toContain("🔎");
      expect(rendered).not.toContain("Web Search");
      expect(rendered).not.toContain("<b>Web Search</b>");
    }
  });
});
