import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import {
  buildFeishuPresentationCard,
  feishuCardWithinTableLimit,
  isFeishuCardWithinEnvelope,
  withinCardTableLimit,
} from "./presentation-card.js";

describe("buildFeishuPresentationCard", () => {
  it("renders table blocks through the portable text fallback", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage", "ARR"],
          rows: [
            ["Acme", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    expect(buildFeishuPresentationCard({ presentation }).body.elements).toEqual([
      {
        tag: "markdown",
        content:
          "Pipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      },
    ]);
  });
});

describe("isFeishuCardWithinEnvelope", () => {
  it("counts nested elements against the 200-element API limit", () => {
    const buildCard = (elementCount: number) => ({
      schema: "2.0",
      body: {
        elements: Array.from({ length: elementCount }, (_entry, index) => ({
          tag: "markdown",
          content: String(index),
        })),
      },
    });

    expect(isFeishuCardWithinEnvelope(buildCard(200))).toBe(true);
    expect(isFeishuCardWithinEnvelope(buildCard(201))).toBe(false);
  });
});

describe("withinCardTableLimit (parser-backed table counting)", () => {
  const pipedTable = "| a | b |\n| - | - |\n| 1 | 2 |";
  const pipelessTable = "a | b\n--- | ---\n1 | 2";
  const repeat = (table: string, count: number) =>
    Array.from({ length: count }, () => table).join("\n\n");

  it("accepts piped and pipe-less GFM tables at the 5-table boundary", () => {
    expect(withinCardTableLimit(repeat(pipedTable, 5))).toBe(true);
    expect(withinCardTableLimit(repeat(pipedTable, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(pipelessTable, 5))).toBe(true);
    expect(withinCardTableLimit(repeat(pipelessTable, 6))).toBe(false);
  });

  it("counts alignment-colon delimiters toward the limit", () => {
    const alignPiped = "| a | b |\n|:--|--:|\n| 1 | 2 |";
    const alignPipeless = "c | d\n:---: | ---\n3 | 4";
    expect(withinCardTableLimit(repeat(alignPiped, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(alignPipeless, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(alignPiped, 5))).toBe(true);
  });

  it("does not count tables inside fenced code blocks", () => {
    expect(withinCardTableLimit("```\n" + repeat(pipedTable, 6) + "\n```")).toBe(true);
    expect(
      withinCardTableLimit("```\n" + repeat(pipedTable, 2) + "\n```\n\n" + repeat(pipedTable, 6)),
    ).toBe(false);
  });

  it("does not count thematic breaks or plain pipes in prose", () => {
    expect(withinCardTableLimit("---\n\nhello | world\n\n2024 | 2025")).toBe(true);
  });

  it("does not treat tables inside an HTML font wrapper as card table components", () => {
    expect(withinCardTableLimit(`<font color='grey'>${repeat(pipedTable, 6)}</font>`)).toBe(true);
  });
});

describe("feishuCardWithinTableLimit", () => {
  const table = "| a | b |\n| - | - |\n| 1 | 2 |";

  it("sums tables across all markdown elements of the card", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
          { tag: "hr" },
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
        ],
      },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(false);
  });

  it("accepts cards with at most 5 tables across elements", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
          { tag: "markdown", content: `${table}\n\n${table}` },
        ],
      },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(true);
  });

  it("accepts cards without markdown tables", () => {
    const card = {
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "plain | pipes but no table" }] },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(true);
  });
});
