import { describe, expect, it } from "vitest";
import { sanitizeOutboundText } from "./sanitize-outbound.js";

describe("sanitizeOutboundText", () => {
  it("returns empty string unchanged", () => {
    expect(sanitizeOutboundText("")).toBe("");
  });

  it("preserves normal user-facing text", () => {
    const text = "Hello! How can I help you today?";
    expect(sanitizeOutboundText(text)).toBe(text);
  });

  it("strips <thinking> tags and content", () => {
    const text = "<thinking>internal reasoning</thinking>The answer is 42.";
    expect(sanitizeOutboundText(text)).toBe("The answer is 42.");
  });

  it("strips <thought> tags and content", () => {
    const text = "<thought>secret</thought>Visible reply";
    expect(sanitizeOutboundText(text)).toBe("Visible reply");
  });

  it("strips <final> tags", () => {
    const text = "<final>Hello world</final>";
    expect(sanitizeOutboundText(text)).toBe("Hello world");
  });

  it("strips <relevant_memories> tags and content", () => {
    const text = "<relevant_memories>memory data</relevant_memories>Visible";
    expect(sanitizeOutboundText(text)).toBe("Visible");
  });

  it("strips +#+#+#+# separator patterns", () => {
    const text = "NO_REPLY +#+#+#+#+#+ more internal stuff";
    expect(sanitizeOutboundText(text)).not.toContain("+#+#");
  });

  it("strips assistant to=final markers", () => {
    const text = "Some text assistant to=final more text";
    const result = sanitizeOutboundText(text);
    expect(result).not.toMatch(/assistant\s+to\s*=\s*final/i);
  });

  it("strips trailing role turn markers", () => {
    const text = "Hello\nassistant:\nuser:";
    const result = sanitizeOutboundText(text);
    expect(result).not.toMatch(/^assistant:$/m);
  });

  it("collapses excessive blank lines after stripping", () => {
    const text = "Hello\n\n\n\n\nWorld";
    expect(sanitizeOutboundText(text)).toBe("Hello\n\nWorld");
  });

  it("handles combined internal markers in one message", () => {
    const text = "<thinking>step 1</thinking>NO_REPLY +#+#+#+# assistant to=final\n\nActual reply";
    const result = sanitizeOutboundText(text);
    expect(result).not.toContain("<thinking>");
    expect(result).not.toContain("+#+#");
    expect(result).not.toMatch(/assistant to=final/i);
    expect(result).toContain("Actual reply");
  });
});
