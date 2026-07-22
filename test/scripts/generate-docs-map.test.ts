import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/generate-docs-map.mjs";

describe("generate docs map", () => {
  it("renders heading HTML as text", () => {
    expect(testing.cleanHeadingText("`API` <script>alert(1)</script>")).toBe(
      "API &lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(testing.cleanHeadingText("<scr<script>ipt>alert(1)</script>")).toBe(
      "&lt;scr&lt;script&gt;ipt&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("preserves Markdown syntax inside inline code", () => {
    expect(testing.cleanHeadingText("`agents.entries.*.contextLimits` and *defaults*")).toBe(
      "`agents.entries.*.contextLimits` and defaults",
    );
    expect(testing.cleanHeadingText("`![label](https://example.test/image)`")).toBe(
      "`![label](https://example.test/image)`",
    );
  });
});
