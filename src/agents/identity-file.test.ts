import { describe, expect, it } from "vitest";
import { mergeIdentityMarkdownContent, parseIdentityMarkdown } from "./identity-file.js";

describe("parseIdentityMarkdown", () => {
  it("ignores identity template placeholders", () => {
    const content = `
# IDENTITY.md - Who Am I?

- **Name:** *(pick something you like)*
- **Creature:** *(AI? robot? familiar? ghost in the machine? something weirder?)*
- **Vibe:** *(how do you come across? sharp? warm? chaotic? calm?)*
- **Emoji:** *(your signature - pick one that feels right)*
- **Avatar:** *(workspace-relative path, http(s) URL, or data URI)*
    `;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed).toStrictEqual({});
  });

  it("parses explicit identity values", () => {
    const content = `
- **Name:** Samantha
- **Creature:** Robot
- **Vibe:** Warm
- **Emoji:** :robot:
- **Avatar:** avatars/openclaw.png
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed).toEqual({
      name: "Samantha",
      creature: "Robot",
      vibe: "Warm",
      emoji: ":robot:",
      avatar: "avatars/openclaw.png",
    });
  });
});

describe("mergeIdentityMarkdownContent", () => {
  it("updates writable fields without clobbering richer identity sections", () => {
    const content = `
# IDENTITY.md - Agent Identity

- **Name:** C-3PO
- **Creature:** Flustered Protocol Droid
- **Vibe:** Anxious, detail-obsessed
- **Emoji:** 🤖

## Role

Fluent in over six million error messages.
`;

    const merged = mergeIdentityMarkdownContent(content, {
      name: "Patch Agent",
      emoji: "🦀",
      avatar: "avatars/patch.png",
    });

    expect(merged).toContain("- Name: Patch Agent");
    expect(merged).toContain("- **Creature:** Flustered Protocol Droid");
    expect(merged).toContain("- **Vibe:** Anxious, detail-obsessed");
    expect(merged).toContain("- Emoji: 🦀");
    expect(merged).toContain("- Avatar: avatars/patch.png");
    expect(merged).toContain("## Role");
    expect(merged).toContain("Fluent in over six million error messages.");
  });

  it("replaces duplicate writable lines with one normalized entry", () => {
    const merged = mergeIdentityMarkdownContent(
      `
- Name: Old Name
- Name: Older Name
- Emoji: 🙂
`,
      { name: "New Name", emoji: "🦀" },
    );

    expect(merged.match(/Name:/g)).toHaveLength(1);
    expect(merged).toContain("- Name: New Name");
    expect(merged).toContain("- Emoji: 🦀");
  });
});
