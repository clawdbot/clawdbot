// Workshop frontmatter tests cover proposal markdown extraction and stripping.
import { describe, expect, it } from "vitest";
import {
  renderProposalMarkdown,
  resolveDraftedSkillDescription,
  stripProposalFrontmatterForSkill,
} from "./frontmatter.js";

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

  it("renders the resolved skill description without duplicating kept frontmatter", () => {
    const richDescription =
      "Route requests through the vendor intake protocol: trigger phrases, keywords, and example calls that exceed the label budget";
    const rendered = renderProposalMarkdown({
      name: "rich-skill",
      description: richDescription,
      content: `---\nname: rich-skill\ndescription: ${richDescription}\n---\n\n# Body\n`,
      date: "2026-07-07T00:00:00.000Z",
    });

    expect(rendered.match(/description:/g)).toHaveLength(1);
    expect(rendered).toContain(richDescription);
    expect(stripProposalFrontmatterForSkill(rendered)).toContain(richDescription);
  });

  it("resolves the drafted description from content before the live fallback and label", () => {
    const contentDescription = "Description drafted in the proposal content";
    const liveDescription = "Live skill description with trigger phrases and keywords";
    expect(
      resolveDraftedSkillDescription({
        content: `---\nname: rich-skill\ndescription: ${contentDescription}\n---\n\n# Body\n`,
        fallbackContent: `---\nname: rich-skill\ndescription: ${liveDescription}\n---\n\n# Old\n`,
        label: "Short listing label",
      }),
    ).toBe(contentDescription);
    expect(
      resolveDraftedSkillDescription({
        content: "# Body only\n",
        fallbackContent: `---\nname: rich-skill\ndescription: ${liveDescription}\n---\n\n# Old\n`,
        label: "Short listing label",
      }),
    ).toBe(liveDescription);
    expect(
      resolveDraftedSkillDescription({
        content: "# Body only\n",
        label: "Short listing label",
      }),
    ).toBe("Short listing label");
  });

  it("prefers an explicitly revised description over previously rendered content", () => {
    const explicitDescription = "Explicitly revised description";
    expect(
      resolveDraftedSkillDescription({
        content: "---\nname: rich-skill\ndescription: Stale rendered description\n---\n\n# Body\n",
        fallbackContent:
          "---\nname: rich-skill\ndescription: Older live description\n---\n\n# Old\n",
        label: "Short listing label",
        explicitDescription,
      }),
    ).toBe(explicitDescription);
    // Without an explicit revision the previously rendered content still wins,
    // so body-only revisions keep the prior description instead of the label.
    expect(
      resolveDraftedSkillDescription({
        content: "# Body only\n",
        fallbackContent:
          "---\nname: rich-skill\ndescription: Prior rich description\n---\n\n# Old\n",
        label: "Short listing label",
      }),
    ).toBe("Prior rich description");
  });
});
