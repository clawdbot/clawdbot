// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("progress-card markdown", () => {
  it("allows only progress markup when explicitly enabled", () => {
    const markdown =
      '<progress value="3" max="7" onclick="alert(1)"></progress><script>alert(2)</script>';

    const defaultHtml = toSanitizedMarkdownHtml(markdown);
    const progressHtml = toSanitizedMarkdownHtml(markdown, { progressBars: true });

    expect(defaultHtml).not.toContain("<progress");
    expect(progressHtml).toContain('<progress value="3" max="7"></progress>');
    expect(progressHtml).not.toContain("onclick");
    expect(progressHtml).not.toContain("<script");
    expect(progressHtml).not.toContain("alert(2)");
  });
});
