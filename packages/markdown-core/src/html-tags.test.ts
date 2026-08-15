import { describe, expect, it } from "vitest";
import { tokenizeHtmlTags } from "./html-tags.js";

describe("tokenizeHtmlTags", () => {
  it("preserves offsets across quoted greater-than characters", () => {
    const html = 'before <a href="https://example.com/?q=>">label</a> after';

    expect([...tokenizeHtmlTags(html)]).toEqual([
      {
        raw: '<a href="https://example.com/?q=>">',
        start: 7,
        end: 42,
        name: "a",
        closing: false,
        selfClosing: false,
      },
      { raw: "</a>", start: 47, end: 51, name: "a", closing: true, selfClosing: false },
    ]);
  });

  it("reports self-closing tags and ignores angle-bracket text", () => {
    expect([...tokenizeHtmlTags("1 < 2 <br/> <not closed")]).toEqual([
      { raw: "<br/>", start: 6, end: 11, name: "br", closing: false, selfClosing: true },
    ]);
  });

  it("does not expose tag-shaped text inside full HTML constructs", () => {
    const html = [
      "<!-- <code>comment</code> -->",
      "<![CDATA[<pre>cdata</pre>]]>",
      "<?test <script>instruction</script> ?>",
      "<strong>visible</strong>",
    ].join("\n");

    expect([...tokenizeHtmlTags(html)].map(({ raw, name }) => ({ raw, name }))).toEqual([
      { raw: "<strong>", name: "strong" },
      { raw: "</strong>", name: "strong" },
    ]);
  });
});
