import { describe, expect, it } from "vitest";
import { skillsCatalogIsActionable } from "./attempt-system-prompt-prepare.js";

/**
 * Regression cover for a run losing `<available_skills>` because a runtime
 * `toolsAllow` list was attached. Cron persists an explicit `["*"]` to record
 * "unrestricted", and agent-created jobs persist a mirror of the creating
 * turn's own tools — both non-empty, both fully privileged.
 */
describe("skillsCatalogIsActionable", () => {
  it("keeps the catalog when no allowlist is set", () => {
    expect(skillsCatalogIsActionable(undefined)).toBe(true);
  });

  it("keeps the catalog for an empty allowlist", () => {
    expect(skillsCatalogIsActionable([])).toBe(true);
  });

  it("keeps the catalog for an explicit wildcard, which means unrestricted", () => {
    expect(skillsCatalogIsActionable(["*"])).toBe(true);
  });

  it("normalizes wildcard entries before matching", () => {
    expect(skillsCatalogIsActionable(["read", " * "])).toBe(true);
  });

  it("keeps the catalog for a cron creator cap that carries read", () => {
    // A real agent-created cron payload: no wildcard, but full read access.
    expect(
      skillsCatalogIsActionable([
        "read",
        "edit",
        "write",
        "exec",
        "process",
        "web_search",
        "web_fetch",
        "memory_search",
      ]),
    ).toBe(true);
  });

  it("drops the catalog for a narrow single-purpose allowlist", () => {
    expect(skillsCatalogIsActionable(["openclaw"])).toBe(false);
  });

  it("drops the catalog when the run cannot read a skill body", () => {
    expect(skillsCatalogIsActionable(["exec", "process"])).toBe(false);
  });
});
