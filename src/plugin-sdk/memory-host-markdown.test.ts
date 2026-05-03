import { describe, expect, it } from "vitest";
import { replaceManagedMarkdownBlock, withTrailingNewline } from "./memory-host-markdown.js";

describe("withTrailingNewline", () => {
  it("preserves trailing newlines", () => {
    expect(withTrailingNewline("hello\n")).toBe("hello\n");
  });

  it("adds a trailing newline when missing", () => {
    expect(withTrailingNewline("hello")).toBe("hello\n");
  });
});

describe("replaceManagedMarkdownBlock", () => {
  it("appends a managed block when missing", () => {
    expect(
      replaceManagedMarkdownBlock({
        original: "# Title\n",
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "- first",
      }),
    ).toBe("# Title\n\n## Generated\n<!-- start -->\n- first\n<!-- end -->\n");
  });

  it("replaces an existing managed block in place", () => {
    expect(
      replaceManagedMarkdownBlock({
        original:
          "# Title\n\n## Generated\n<!-- start -->\n- old\n<!-- end -->\n\n## Notes\nkept\n",
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "- new",
      }),
    ).toBe("# Title\n\n## Generated\n<!-- start -->\n- new\n<!-- end -->\n\n## Notes\nkept\n");
  });

  it("supports headingless blocks", () => {
    expect(
      replaceManagedMarkdownBlock({
        original: "alpha\n",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "beta",
      }),
    ).toBe("alpha\n\n<!-- start -->\nbeta\n<!-- end -->\n");
  });

  it("replaces headed blocks with CRLF line endings in place", () => {
    expect(
      replaceManagedMarkdownBlock({
        original: "# Title\r\n\r\n## Generated\r\n<!-- start -->\r\n- old\r\n<!-- end -->\r\n",
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "- new",
      }),
    ).toBe("# Title\r\n\r\n## Generated\n<!-- start -->\n- new\n<!-- end -->\r\n");
  });

  it("collapses pre-existing duplicate managed blocks into one", () => {
    const original = [
      "# Title",
      "",
      "## Generated",
      "<!-- start -->",
      "- run-1",
      "<!-- end -->",
      "",
      "## Generated",
      "<!-- start -->",
      "- run-2",
      "<!-- end -->",
      "",
      "## Generated",
      "<!-- start -->",
      "- run-3",
      "<!-- end -->",
      "",
    ].join("\n");

    const updated = replaceManagedMarkdownBlock({
      original,
      heading: "## Generated",
      startMarker: "<!-- start -->",
      endMarker: "<!-- end -->",
      body: "- latest",
    });

    expect(updated).toBe("# Title\n\n## Generated\n<!-- start -->\n- latest\n<!-- end -->\n");
    expect(updated.match(/<!-- start -->/g)?.length).toBe(1);
    expect(updated).not.toContain("run-");
  });

  it("preserves unmanaged markdown while removing duplicate blocks", () => {
    const original = [
      "# Title",
      "",
      "Paragraph A",
      "",
      "",
      "Paragraph B",
      "",
      "## Generated",
      "<!-- start -->",
      "- old",
      "<!-- end -->",
      "",
      "## Generated",
      "<!-- start -->",
      "- stale",
      "<!-- end -->",
      "",
      "## Notes",
      "kept",
      "",
      "",
    ].join("\n");

    expect(
      replaceManagedMarkdownBlock({
        original,
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "- new",
      }),
    ).toBe(
      "# Title\n\nParagraph A\n\n\nParagraph B\n\n## Generated\n<!-- start -->\n- new\n<!-- end -->\n\n## Notes\nkept\n\n",
    );
  });

  it("is idempotent across repeated calls with the same body", () => {
    const params = {
      heading: "## Generated",
      startMarker: "<!-- start -->",
      endMarker: "<!-- end -->",
      body: "- only",
    } as const;
    const first = replaceManagedMarkdownBlock({ original: "# Title\n", ...params });
    const second = replaceManagedMarkdownBlock({ original: first, ...params });
    const third = replaceManagedMarkdownBlock({ original: second, ...params });

    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
