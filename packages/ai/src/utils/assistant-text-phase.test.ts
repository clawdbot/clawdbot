import { describe, expect, it } from "vitest";
import {
  clearPendingCommentaryText,
  rememberPendingCommentaryTags,
  tagPendingCommentaryText,
} from "./assistant-text-phase.js";

type TestTextBlock = { type: "text"; text: string; textSignature?: string };

describe("assistant text phase tags", () => {
  it("tags only unphased non-empty text and remains idempotent", () => {
    const content = [
      { type: "text", text: "I will check." },
      { type: "text", text: " " },
      { type: "text", text: "existing", textSignature: "provider-signature" },
    ];
    const tags = tagPendingCommentaryText(content);
    rememberPendingCommentaryTags(tags, tagPendingCommentaryText(content));

    expect(tags.size).toBe(1);
    expect(JSON.parse(String(content[0]?.textSignature))).toMatchObject({
      v: 1,
      id: "commentary-1",
      phase: "commentary",
    });
    expect(content[1]?.textSignature).toBeUndefined();
    expect(content[2]?.textSignature).toBe("provider-signature");
  });

  it("rolls back only unchanged signatures created by this turn", () => {
    const generated: TestTextBlock = { type: "text", text: "generated" };
    const replaced: TestTextBlock = { type: "text", text: "replaced" };
    const existing: TestTextBlock = {
      type: "text",
      text: "existing",
      textSignature: "provider-signature",
    };
    const tags = tagPendingCommentaryText([generated, replaced, existing]);
    replaced.textSignature = "provider-replacement";

    clearPendingCommentaryText(tags);

    expect(generated.textSignature).toBeUndefined();
    expect(replaced.textSignature).toBe("provider-replacement");
    expect(existing.textSignature).toBe("provider-signature");
  });
});
