import { describe, expect, it, vi } from "vitest";
import { inheritSessionSelection, SessionLabelOwnerIndex } from "./session-entry-selection.js";
import type { SessionEntry } from "./types.js";

describe("inheritSessionSelection", () => {
  it("inherits canonical user and automatic provenance without the old generation", () => {
    expect(
      inheritSessionSelection({
        sessionId: "legacy-user",
        updatedAt: 1,
        authProfileOverride: "openai:work",
      }),
    ).toMatchObject({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });

    const automatic = inheritSessionSelection({
      sessionId: "legacy-auto",
      updatedAt: 1,
      authProfileOverride: "openai:fallback",
      authProfileOverrideCompactionCount: 0,
    });
    expect(automatic).toMatchObject({
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
    });
    expect(automatic.authProfileOverrideCompactionCount).toBeUndefined();
  });
});

describe("SessionLabelOwnerIndex", () => {
  it("indexes the store once and answers repeated conflicts without rescanning entries", () => {
    const labelReads = vi.fn();
    const entry = (sessionId: string, label: string): SessionEntry => {
      const value = { sessionId, updatedAt: 1 } as SessionEntry;
      Object.defineProperty(value, "label", {
        enumerable: true,
        get: () => {
          labelReads();
          return label;
        },
      });
      return value;
    };
    const store = {
      "agent:main:a": entry("a", "Alpha"),
      "agent:main:b": entry("b", "Beta"),
    };
    const index = new SessionLabelOwnerIndex(store);

    expect(labelReads).toHaveBeenCalledTimes(2);
    for (let iteration = 0; iteration < 20; iteration += 1) {
      expect(index.isLabelInUse("Alpha", ["agent:main:b"])).toBe(true);
      expect(index.isLabelInUse("Beta", ["agent:main:b"])).toBe(false);
    }
    expect(labelReads).toHaveBeenCalledTimes(2);
  });
});
