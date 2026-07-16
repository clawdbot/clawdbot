import { describe, it, expect } from "vitest";
import { FUZZY_MEDIA_TAG_REGEX, SELF_CLOSING_TAG_REGEX } from "./media-tags.js";

describe("media-tags with HTML entities", () => {
  it("extracts URL from entity-encoded fuzzy tag", () => {
    const input = "&lt;qqimg&gt;https://example.com/a.png&lt;/qqimg&gt;";
    FUZZY_MEDIA_TAG_REGEX.lastIndex = 0;
    const match = FUZZY_MEDIA_TAG_REGEX.exec(input);
    expect(match?.[2]).toBe("https://example.com/a.png");
  });

  it("extracts URL from mixed entity+plain tag", () => {
    const input = "&lt;qqimg&gt;https://example.com/b.png</qqimg>";
    FUZZY_MEDIA_TAG_REGEX.lastIndex = 0;
    const match = FUZZY_MEDIA_TAG_REGEX.exec(input);
    expect(match?.[2]).toBe("https://example.com/b.png");
  });

  it("extracts file from entity-encoded self-closing tag", () => {
    const input = '&lt;qqmedia file="https://example.com/c.zip" /&gt;';
    SELF_CLOSING_TAG_REGEX.lastIndex = 0;
    const match = SELF_CLOSING_TAG_REGEX.exec(input);
    expect(match?.[2]).toBe("https://example.com/c.zip");
  });

  it("does not match invalid input", () => {
    const input = "no tag here";
    FUZZY_MEDIA_TAG_REGEX.lastIndex = 0;
    const match = FUZZY_MEDIA_TAG_REGEX.exec(input);
    expect(match).toBeNull();
  });
});
