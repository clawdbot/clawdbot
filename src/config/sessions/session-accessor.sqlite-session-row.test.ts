import { describe, expect, it } from "vitest";
import { bindSessionNode } from "./session-accessor.sqlite-session-row.js";
import type { SessionEntry } from "./types.js";

describe("bindSessionNode", () => {
  // resolvedSkills is runtime-only (SessionSkillSnapshot): persistence keeps the
  // lightweight catalog/prompt; consumers hydrate concrete SKILL.md paths from a
  // fresh workspace scan on resume (snapshot-hydration). Persisting the full
  // ~293 KB catalog into every session_nodes.entry_json blocks the event loop
  // and bloats the DB (#126663); the file-store path already strips it.
  it("strips runtime-only resolvedSkills from the persisted entry_json", () => {
    const entry = {
      sessionId: "sess-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      skillsSnapshot: {
        prompt: "skill prompt",
        skills: [{ name: "alpha" }],
        resolvedSkills: [{ name: "alpha", filePath: "/abs/skills/alpha/SKILL.md" }],
      },
    } as unknown as SessionEntry;

    const node = bindSessionNode({
      entry,
      sessionKey: "agent:sess-1",
      updatedAt: 2_000,
    });

    const persisted = JSON.parse(node.entry_json as string) as {
      skillsSnapshot?: {
        resolvedSkills?: unknown;
        prompt?: string;
        skills?: unknown[];
      };
    };

    // The lightweight catalog/prompt must survive persistence.
    expect(persisted.skillsSnapshot?.prompt).toBe("skill prompt");
    expect(persisted.skillsSnapshot?.skills).toEqual([{ name: "alpha" }]);
    // The runtime-only resolved skills catalog must not be persisted.
    expect(persisted.skillsSnapshot?.resolvedSkills).toBeUndefined();
  });
});
