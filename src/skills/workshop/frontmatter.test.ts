// Workshop frontmatter tests cover proposal markdown extraction and stripping.
import { describe, expect, it } from "vitest";
import { renderProposalMarkdown, stripProposalFrontmatterForSkill } from "./frontmatter.js";

describe("workshop proposal frontmatter", () => {
  it("preserves dash-prefixed Markdown when rendering proposals", () => {
    const rendered = renderProposalMarkdown({
      name: "dash-prefix",
      description: "Preserve dash-prefixed Markdown",
      content: "---not\nname: nope\n---not\n# Body\n",
      date: "2026-07-07T00:00:00.000Z",
    });

    expect(rendered.startsWith('---\nname: "dash-prefix"')).toBe(true);
    expect(rendered).toContain("\n---not\nname: nope\n---not\n# Body\n");
  });

  it("does not strip dash-prefixed Markdown as proposal frontmatter", () => {
    expect(stripProposalFrontmatterForSkill("---not\nname: nope\n---not\n# Body\n")).toBe(
      "---not\nname: nope\n---not\n# Body\n",
    );
  });
});
