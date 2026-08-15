import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("markdownToIR raw HTML", () => {
  it("does not linkify URLs inside raw HTML tag attributes", () => {
    const ir = markdownToIR(
      '<img src="https://example.com/diagram.png" alt="Diagram"> https://example.com/page',
    );

    expect(ir.text).toBe(
      '<img src="https://example.com/diagram.png" alt="Diagram"> https://example.com/page',
    );
    expect(ir.links.map((link) => ir.text.slice(link.start, link.end))).toEqual([
      "https://example.com/page",
    ]);
  });

  it("does not treat comparison text as a raw HTML tag", () => {
    const ir = markdownToIR("x < y https://example.com/page");

    expect(ir.links.map((link) => ir.text.slice(link.start, link.end))).toEqual([
      "https://example.com/page",
    ]);
  });
});
