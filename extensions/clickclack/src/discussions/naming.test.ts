import { describe, expect, it } from "vitest";
import {
  fallbackDiscussionLabel,
  resolveDiscussionLabel,
  slugifyDiscussionLabel,
} from "./naming.js";

describe("ClickClack discussion naming", () => {
  it.each([
    {
      entry: { label: " Explicit ", displayName: "Generated", subject: "Subject" },
      expected: "Explicit",
    },
    {
      entry: { label: "  ", displayName: " Generated ", subject: "Subject" },
      expected: "Generated",
    },
    {
      entry: { label: "", displayName: "  ", subject: " Subject " },
      expected: "Subject",
    },
  ])("resolves and trims the first available title", ({ entry, expected }) => {
    expect(resolveDiscussionLabel(entry, "agent:main:naming", "main")).toBe(expected);
  });

  it("uses compact agent-scoped and agentless fallbacks", () => {
    const sessionKey = "agent:main:naming";

    expect(fallbackDiscussionLabel(sessionKey, " Main ")).toMatch(/^s-main-[0-9a-f]{8}$/u);
    expect(fallbackDiscussionLabel(sessionKey)).toMatch(/^s-[0-9a-f]{8}$/u);
    expect(resolveDiscussionLabel({}, sessionKey, "main")).toBe(
      fallbackDiscussionLabel(sessionKey, "main"),
    );
  });

  it("preserves discussion slug normalization", () => {
    expect(slugifyDiscussionLabel("  Déjà vu / Release!  ", "unused")).toBe("deja-vu-release");
  });
});
