import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPageSharePayload, capturePageShare } from "./page-share-core.js";

const PAGE_SHARE_MAX_CONTENT_CHARS = 120_000;
const PAGE_SHARE_MAX_NOTE_CHARS = 2_000;
const PAGE_SHARE_MAX_TITLE_CHARS = 500;
const PAGE_SHARE_MAX_URL_CHARS = 2_000;

describe("page share core", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exports Google documents in the tab using the document id", async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ result: "" }])
      .mockResolvedValueOnce([{ result: { text: "Document body" } }]);
    vi.stubGlobal("chrome", { scripting: { executeScript } });

    await expect(
      capturePageShare({
        id: 17,
        url: "https://docs.google.com/document/d/document-id_123/edit?tab=t.0",
        title: "Document",
      }),
    ).resolves.toEqual({
      url: "https://docs.google.com/document/d/document-id_123/edit?tab=t.0",
      title: "Document",
      selection: "",
      content: "Document body",
    });
    expect(executeScript.mock.calls[1]?.[0]).toMatchObject({
      target: { tabId: 17 },
      args: ["document-id_123"],
    });
  });

  it("keeps text at the boundary and marks truncation beyond it", () => {
    const atBoundary = buildPageSharePayload({
      url: "https://example.com",
      title: "Example",
      content: "x".repeat(PAGE_SHARE_MAX_CONTENT_CHARS),
    });
    const beyondBoundary = buildPageSharePayload({
      url: "https://example.com",
      title: "Example",
      content: "x".repeat(PAGE_SHARE_MAX_CONTENT_CHARS + 1),
    });
    expect(atBoundary.content).toHaveLength(PAGE_SHARE_MAX_CONTENT_CHARS);
    expect(
      beyondBoundary.content.endsWith(
        `[Truncated: original was ${PAGE_SHARE_MAX_CONTENT_CHARS + 1} characters]`,
      ),
    ).toBe(true);
  });

  it("trims fields, preserves newlines, applies caps, and drops empty optionals", () => {
    const payload = buildPageSharePayload({
      url: ` https://example.com/${"u".repeat(PAGE_SHARE_MAX_URL_CHARS)} `,
      title: ` ${"t".repeat(PAGE_SHARE_MAX_TITLE_CHARS + 10)} `,
      content: `  first   line  \n second\tline ${"c".repeat(PAGE_SHARE_MAX_CONTENT_CHARS)} `,
      selection: "   ",
      note: ` ${"n".repeat(PAGE_SHARE_MAX_NOTE_CHARS + 10)} `,
    });

    expect(payload.url).toHaveLength(PAGE_SHARE_MAX_URL_CHARS);
    expect(payload.title).toHaveLength(PAGE_SHARE_MAX_TITLE_CHARS);
    expect(payload.content).toContain("first line \n second line");
    expect(payload.content).toContain("[Truncated: original was");
    expect(payload.note).toHaveLength(PAGE_SHARE_MAX_NOTE_CHARS);
    expect(payload).not.toHaveProperty("selection");
  });

  it("keeps the injected capture function self-contained", async () => {
    const executeScript = vi.fn().mockResolvedValue([
      {
        result: {
          url: "https://example.com",
          title: "Example",
          selection: "",
          content: "Body",
        },
      },
    ]);
    vi.stubGlobal("chrome", { scripting: { executeScript } });

    await capturePageShare({ id: 9, url: "https://example.com", title: "Example" });
    const source = String(executeScript.mock.calls[0]?.[0].func);
    expect(source).not.toMatch(/\b(?:import|require)\b/u);
  });
});
