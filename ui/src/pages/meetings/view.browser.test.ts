import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../styles.css";
import "./meetings.css";
import { meetingEntry, meetingPage } from "../../test-helpers/transcripts.test-support.ts";
import { renderTranscripts } from "./view.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  container.remove();
});

function readerProps(): Parameters<typeof renderTranscripts>[0] {
  return {
    basePath: "",
    search: "?selector=meeting",
    drafts: {},
    onDraft: vi.fn(),
    connected: true,
    allowed: true,
    list: { sessions: [meetingEntry], nextCursor: null },
    listLoading: false,
    listError: null,
    reader: {
      summary: meetingPage,
      pages: [
        {
          ...meetingPage,
          utterances: [{ sequence: 0, speakerLabel: "Avery", text: "Unbroken".repeat(120) }],
        },
      ],
      loading: false,
      error: null,
      trimmed: false,
    },
    readerTab: "text",
    exportState: { kind: "idle" },
    onNavigate: vi.fn(),
    onRefresh: vi.fn(),
    onReaderRetry: vi.fn(),
    onReaderTab: vi.fn(),
    onLoadMore: vi.fn(),
    onReaderStart: vi.fn(),
    onDownload: vi.fn(),
  };
}

describe.skipIf(!hasBrowserLayout)("meeting transcript responsive reader", () => {
  it("keeps long speaker text inside the reading column and switches to a mobile drill-in", async () => {
    const { page } = await import("vitest/browser");
    const props = readerProps();
    await page.viewport(1320, 900);
    render(renderTranscripts(props), container);
    const library = document.querySelector<HTMLElement>(".transcripts-library")!;
    const reader = document.querySelector<HTMLElement>(".transcripts-reader")!;
    expect(getComputedStyle(library).display).not.toBe("none");
    expect(reader.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      library.getBoundingClientRect().right - 1,
    );
    expect(reader.scrollWidth).toBeLessThanOrEqual(reader.clientWidth + 1);
    await page.viewport(390, 844);
    expect(getComputedStyle(library).display).toBe("none");
    expect(reader.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(reader.scrollWidth).toBeLessThanOrEqual(reader.clientWidth + 1);
    const summary = document.querySelector<HTMLElement>("#transcript-reader-tab-summary")!;
    summary.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(props.onReaderTab).toHaveBeenCalledWith("summary");
    render(renderTranscripts({ ...props, readerTab: "summary" }), container);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain(
      "Notes extracted using text heuristics",
    );
  });
  it("uses themed search controls and keeps the third library entry above the fold", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(1440, 1000);
    const props = readerProps();
    props.list = {
      sessions: [
        meetingEntry,
        { ...meetingEntry, selector: "second" },
        { ...meetingEntry, selector: "third" },
      ],
      nextCursor: null,
    };
    render(renderTranscripts(props), container);
    const libraryInput = document.querySelector<HTMLInputElement>('input[name="query"]')!;
    const readerInput = document.querySelector<HTMLInputElement>('input[name="find"]')!;
    const libraryStyle = getComputedStyle(libraryInput);
    const readerStyle = getComputedStyle(readerInput);
    for (const property of ["backgroundColor", "borderRadius", "paddingLeft"] as const) {
      expect(readerStyle[property]).toBe(libraryStyle[property]);
    }
    const third = document.querySelectorAll(".transcripts-list__entry")[2]!;
    expect(third.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
    expect(document.querySelector<HTMLDetailsElement>(".transcripts-filters details")!.open).toBe(
      false,
    );
  });

  it("renders stored Markdown notes with bounded paragraph spacing", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(1440, 1000);
    const props = readerProps();
    props.readerTab = "summary";
    props.reader.summary = {
      ...meetingPage,
      summary: {
        ...meetingPage.summary!,
        markdown:
          "# Design review\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Next steps\n- Follow up.\n",
      },
    };
    render(renderTranscripts(props), container);
    const notes = container.querySelector<HTMLElement>(".meetings-notes")!;
    const paragraphs = notes.querySelectorAll("p");
    expect([...paragraphs].map((paragraph) => paragraph.textContent)).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);
    expect(notes.querySelector("h2")?.textContent).toBe("Next steps");
    expect(notes.querySelector("li")?.textContent).toBe("Follow up.");
    const lineHeight = Number.parseFloat(getComputedStyle(paragraphs[0]!).lineHeight);
    expect(
      paragraphs[1]!.getBoundingClientRect().top - paragraphs[0]!.getBoundingClientRect().bottom,
    ).toBeLessThan(lineHeight * 2);
  });
});
