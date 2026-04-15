import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWikiPageFilename, slugifyWikiSegment } from "./markdown.js";

describe("slugifyWikiSegment", () => {
  it("preserves Unicode letters and numbers in wiki slugs", () => {
    expect(slugifyWikiSegment("大语言模型概述")).toBe("大语言模型概述");
    expect(slugifyWikiSegment("LLM 架构分析")).toBe("llm-架构分析");
    expect(slugifyWikiSegment("Circuit Breaker 自動恢復")).toBe("circuit-breaker-自動恢復");
  });

  it("keeps ASCII behavior unchanged", () => {
    expect(slugifyWikiSegment("hello world")).toBe("hello-world");
    expect(slugifyWikiSegment("")).toBe("page");
  });

  it("retains combining marks so distinct titles do not collapse", () => {
    expect(slugifyWikiSegment("किताब")).toBe("किताब");
    expect(slugifyWikiSegment("कुतुब")).toBe("कुतुब");
    expect(slugifyWikiSegment("कीताब")).toBe("कीताब");
  });

  it("caps long Unicode slugs to a safe filename byte length", () => {
    const title = "漢".repeat(90);
    const slug = slugifyWikiSegment(title);

    expect(slug.endsWith(`-${createHash("sha1").update(title).digest("hex").slice(0, 12)}`)).toBe(
      true,
    );
    expect(Buffer.byteLength(slug)).toBeLessThanOrEqual(240);
    expect(slugifyWikiSegment(title)).toBe(slug);
  });

  it("caps composed wiki page filenames to a safe path-component length", () => {
    const stem = `bridge-${"漢".repeat(45)}-${"語".repeat(45)}`;
    const fileName = createWikiPageFilename(stem);

    expect(fileName.endsWith(".md")).toBe(true);
    expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
    expect(createWikiPageFilename(stem)).toBe(fileName);
  });
});
