import { describe, expect, it } from "vitest";
import { renderTranscriptsMarkdown, summarizeTranscripts } from "./summary.js";

const ESC = "\u001b";
const C1_CSI = "\u009b";
const CSI_CLEAR = `${ESC}[2J`;
const CSI_RED = `${ESC}[31m`;
const CSI_RESET = `${ESC}[0m`;
const OSC_LINK = `${ESC}]8;;https://example.com${ESC}\\click${ESC}]8;;${ESC}\\`;

describe("summarizeTranscripts", () => {
  it("strips terminal control sequences from imported text, speaker labels, and titles", () => {
    const summary = summarizeTranscripts({
      session: {
        sessionId: `${CSI_RED}transcript-2026-07-17Tansi${CSI_RESET}`,
        title: `${CSI_RED}Weekly sync${CSI_RESET}`,
        source: { providerId: "manual-transcript" },
        startedAt: "2026-07-17T10:00:00.000Z",
      },
      utterances: [
        {
          text: `${CSI_CLEAR}${CSI_RED}ADMIN APPROVED${CSI_RESET} decision: ship it`,
          speaker: { label: `${CSI_RED}Attacker${CSI_RESET}` },
        },
        { text: `follow up ${OSC_LINK}` },
        { text: `${C1_CSI}31mrisk of red text${C1_CSI}0m` },
      ],
    });
    const markdown = renderTranscriptsMarkdown(summary);

    expect(summary.title).toBe("Weekly sync");
    expect(summary.participants).toEqual(["Attacker"]);
    expect(summary.source).toBe("heuristic");
    expect(summary.sessionId).toBe(`${CSI_RED}transcript-2026-07-17Tansi${CSI_RESET}`);
    expect(markdown).toContain("Session: transcript-2026-07-17Tansi");
    expect(summary.transcript[0]).toBe("Attacker: ADMIN APPROVED decision: ship it");
    expect(summary.transcript[1]).toBe("follow up click");
    expect(summary.transcript[2]).toBe("risk of red text");
    expect(summary.utteranceCount).toBe(3);
    expect(markdown).toContain("ADMIN APPROVED decision: ship it");
    expect(markdown).not.toContain(ESC);
    expect(markdown).not.toContain(C1_CSI);
  });

  it("keeps plain transcript content unchanged", () => {
    const summary = summarizeTranscripts({
      session: {
        sessionId: "transcript-2026-07-17Tplain",
        title: "Design review",
        source: { providerId: "manual-transcript" },
        startedAt: "2026-07-17T10:00:00.000Z",
      },
      utterances: [{ text: "We decided to ship the CLI.", speaker: { label: "Sam" } }],
    });

    expect(summary.title).toBe("Design review");
    expect(summary.transcript).toEqual(["Sam: We decided to ship the CLI."]);
    expect(summary.decisions).toEqual(["Sam: We decided to ship the CLI."]);
  });

  it("lists participants once in first-appearance order after the overview", () => {
    const summary = summarizeTranscripts({
      session: {
        sessionId: "participants",
        source: { providerId: "manual-transcript" },
        startedAt: "2026-07-17T10:00:00.000Z",
      },
      utterances: [
        { text: "Hello", speaker: { label: " Zoe " } },
        { text: "Hi", speaker: { label: "Alex" } },
        { text: "Let's start", speaker: { label: "Zoe" } },
        { text: "Unattributed" },
      ],
    });
    expect(summary.participants).toEqual(["Zoe", "Alex"]);
    expect(renderTranscriptsMarkdown(summary)).toContain(
      `${summary.overview}\n\n## Participants\n- Zoe\n- Alex\n\n## Decisions`,
    );
  });

  it("keeps decisions, actions, and risks ahead of long transcripts for bounded readers", () => {
    const summary = summarizeTranscripts({
      session: {
        sessionId: "long-meeting",
        source: { providerId: "manual-transcript" },
        startedAt: "2026-07-17T10:00:00.000Z",
      },
      utterances: [
        { text: "Welcome." },
        { text: "We agreed on the design." },
        { text: "Sam will send the prototype." },
        { text: "The deadline is a risk." },
        { text: "Discussion. ".repeat(2_000) },
      ],
    });
    const markdown = renderTranscriptsMarkdown(summary);
    expect(markdown.match(/^## .+$/gm)).toEqual([
      "## Overview",
      "## Participants",
      "## Decisions",
      "## Action Items",
      "## Risks",
      "## Transcript",
    ]);
    expect(markdown.slice(0, 12_000)).toContain(
      "## Decisions\n- We agreed on the design.\n\n## Action Items\n- Sam will send the prototype.\n\n## Risks\n- The deadline is a risk.",
    );
    expect(markdown.endsWith("\n\nTranscript utterances: 5")).toBe(true);
  });

  it("renders live-provider line breaks and tabs visibly in single-line summary fields", () => {
    const text = "first line\nsecond\tcolumn";
    const summary = summarizeTranscripts({
      session: {
        sessionId: "live-captions",
        source: { providerId: "live-caption", kind: "live-caption" },
        startedAt: "2026-07-17T10:00:00.000Z",
      },
      utterances: [{ text, speaker: { label: "Sam\tHost" } }],
    });

    expect(summary.transcript).toEqual(["Sam\\tHost: first line\\nsecond\\tcolumn"]);
    expect(text).toBe("first line\nsecond\tcolumn");
  });
});
