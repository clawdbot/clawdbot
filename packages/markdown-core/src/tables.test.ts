// Markdown Core tests cover tables behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertMarkdownTables } from "./tables.js";

const markdownToIRWithMetaMock = vi.hoisted(() => vi.fn());

vi.mock("./ir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ir.js")>();
  markdownToIRWithMetaMock.mockImplementation(actual.markdownToIRWithMeta);
  return { ...actual, markdownToIRWithMeta: markdownToIRWithMetaMock };
});

describe("convertMarkdownTables", () => {
  beforeEach(() => {
    markdownToIRWithMetaMock.mockClear();
  });

  it("falls back to code rendering for block mode", () => {
    const rendered = convertMarkdownTables("| A | B |\n|---|---|\n| 1 | 2 |", "block");

    expect(rendered).toBe("```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```");
  });

  it("does not parse ordinary text that cannot contain a table", () => {
    const text = "Ordinary iMessage reply with **bold** and _emphasis_.";

    expect(convertMarkdownTables(text, "code")).toBe(text);
    expect(markdownToIRWithMetaMock).not.toHaveBeenCalled();
  });
});
