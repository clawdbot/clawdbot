import { describe, expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { SESSION_LABEL_MAX_LENGTH, parseSessionLabel } from "../sessions/session-label.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";
import { forkedSessionLabel } from "./session-create-service.js";

describe("buildForkedGatewaySessionEntry", () => {
  it("preserves adopted node ancestry and links the replaced generation", () => {
    const previous: SessionEntry = {
      sessionId: "adopted-generation",
      updatedAt: 1,
      lifecycleRunId: "adopted-run",
      forkSource: { sessionKey: "agent:main:original", sessionId: "original-generation" },
    };

    const forked = buildForkedGatewaySessionEntry(
      previous,
      { sessionId: "next-generation", sessionFile: "/tmp/next-generation.jsonl" },
      { sessionKey: "agent:main:new-parent", sessionId: "new-parent-generation" },
      previous,
    );

    expect(forked).toMatchObject({
      sessionId: "next-generation",
      previousSessionId: "adopted-generation",
      forkSource: { sessionKey: "agent:main:original", sessionId: "original-generation" },
    });
    expect(forked.lifecycleRunId).toBeUndefined();
  });

  it("uses the requested ancestry for a genuinely new node", () => {
    const entry: SessionEntry = { sessionId: "provisional", updatedAt: 1 };
    const forked = buildForkedGatewaySessionEntry(
      entry,
      { sessionId: "forked", sessionFile: "/tmp/forked.jsonl" },
      { sessionKey: "agent:main:parent", sessionId: "parent-generation" },
    );

    expect(forked.forkSource).toEqual({
      sessionKey: "agent:main:parent",
      sessionId: "parent-generation",
    });
    expect(forked.previousSessionId).toBeUndefined();
  });
});

describe("forkedSessionLabel", () => {
  it("inherits the parent name with the first free copy number", () => {
    expect(forkedSessionLabel("Release notes", () => false)).toBe("Release notes (2)");
    expect(forkedSessionLabel("Release notes", (label) => label === "Release notes (2)")).toBe(
      "Release notes (3)",
    );
  });

  it("counts from the original name rather than stacking suffixes", () => {
    expect(forkedSessionLabel("Release notes (2)", () => false)).toBe("Release notes (2)");
  });

  it("keeps the suffix inside the label limit a parent may legally fill", () => {
    const full = "n".repeat(SESSION_LABEL_MAX_LENGTH);
    const forked = forkedSessionLabel(full, () => false);
    // A parent is allowed the whole budget; the fork must still validate, so the
    // inherited base gives way to the suffix instead of overflowing past it.
    expect(forked).toBeDefined();
    expect(parseSessionLabel(forked ?? "").ok).toBe(true);
    expect(forked?.endsWith(" (2)")).toBe(true);
  });

  it("leaves an unnamed parent unnamed", () => {
    expect(forkedSessionLabel(undefined, () => false)).toBeUndefined();
    expect(forkedSessionLabel("   ", () => false)).toBeUndefined();
  });
});
