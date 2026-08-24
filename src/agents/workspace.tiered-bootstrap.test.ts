import { describe, expect, it } from "vitest";
import {
  filterBootstrapFilesForSession,
  resolveBootstrapTier,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

function makeFile(name: string, missing = false): WorkspaceBootstrapFile {
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/workspace/${name}`,
    content: "test",
    missing,
    source: "root",
  };
}

function makeHookFile(name: string, relPath: string): WorkspaceBootstrapFile {
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/workspace/${relPath}`,
    content: "extra",
    missing: false,
    source: "hook",
  };
}

// Session key formats: agent:<agentId>:<rest>
const MAIN_KEY = "agent:main:main";
const SUBAGENT_KEY = "agent:main:subagent:task123";
const CRON_KEY = "agent:main:cron:job123";

const STANDARD_FILES: WorkspaceBootstrapFile[] = [
  makeFile("AGENTS.md"),
  makeFile("SOUL.md"),
  makeFile("TOOLS.md"),
  makeFile("IDENTITY.md"),
  makeFile("USER.md"),
  makeFile("HEARTBEAT.md"),
  makeFile("BOOTSTRAP.md"),
  makeFile("MEMORY.md"),
];

// Simulate extra bootstrap files loaded via the bootstrap-extra-files hook
const EXTRA_FILES: WorkspaceBootstrapFile[] = [makeFile("PROJECT.md"), makeFile("CONVENTIONS.md")];

const ALL_FILES: WorkspaceBootstrapFile[] = [...STANDARD_FILES, ...EXTRA_FILES];

describe("resolveBootstrapTier", () => {
  it("returns 'standard' for main sessions without override", () => {
    expect(resolveBootstrapTier(undefined)).toBe("standard");
    expect(resolveBootstrapTier(MAIN_KEY)).toBe("standard");
  });

  it("returns 'minimal' for subagent sessions", () => {
    expect(resolveBootstrapTier(SUBAGENT_KEY)).toBe("minimal");
  });

  it("returns 'minimal' for cron sessions", () => {
    expect(resolveBootstrapTier(CRON_KEY)).toBe("minimal");
  });

  it("respects explicit tier override for main sessions", () => {
    expect(resolveBootstrapTier(MAIN_KEY, "minimal")).toBe("minimal");
    expect(resolveBootstrapTier(MAIN_KEY, "full")).toBe("full");
  });

  it("respects explicit tier override for subagent sessions", () => {
    expect(resolveBootstrapTier(SUBAGENT_KEY, "standard")).toBe("standard");
    expect(resolveBootstrapTier(SUBAGENT_KEY, "full")).toBe("full");
  });
});

describe("filterBootstrapFilesForSession", () => {
  // No-override defaults — preserves upstream's session-type heuristic so this
  // PR stays backward-compatible with callers that haven't opted into the tier
  // system via `agents.defaults.bootstrapTier`.
  it("returns every loaded file for a main session by default (upstream parity)", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY);
    expect(result).toHaveLength(ALL_FILES.length);
    expect(result.map((f) => f.name)).toContain("PROJECT.md");
  });

  /*
   * ⚠️ These two assert PARITY WITH UPSTREAM, so the expected values must track
   * upstream's allowlists rather than whatever they were when this PR opened.
   * Upstream has since narrowed both (subagent dropped TOOLS.md; cron dropped
   * TOOLS.md), which is exactly the kind of drift this pair is here to catch.
   */
  it("returns upstream's subagent allowlist by default (upstream parity)", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, SUBAGENT_KEY);
    expect(result.map((f) => f.name).toSorted()).toEqual(["AGENTS.md"]);
  });

  it("returns upstream's cron allowlist by default (upstream parity)", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, CRON_KEY);
    expect(result.map((f) => f.name).toSorted()).toEqual([
      "AGENTS.md",
      "IDENTITY.md",
      "SOUL.md",
      "USER.md",
    ]);
  });

  // Explicit tier-override path — new behavior added by this PR.
  it("returns standard tier files when bootstrapTier=standard for a main session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "standard");
    const names = result.map((f) => f.name);
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("HEARTBEAT.md");
    expect(names).toContain("BOOTSTRAP.md");
    expect(names).toContain("MEMORY.md");
    expect(names).not.toContain("PROJECT.md");
  });

  /*
   * Privacy runs BEFORE the tier, and the tier must not be able to undo it.
   * A subagent session counts as non-private, so the root MEMORY.md is dropped
   * even though `standard` would otherwise include it — the tier decides how
   * much context to spend, never what a session is allowed to see.
   */
  it("keeps root MEMORY.md out of a subagent session even at standard tier", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, SUBAGENT_KEY, "standard");
    const names = result.map((f) => f.name);
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("HEARTBEAT.md");
    expect(names).not.toContain("MEMORY.md");
    expect(names).not.toContain("PROJECT.md");
  });

  it("returns minimal tier files when bootstrapTier=minimal for a subagent session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, SUBAGENT_KEY, "minimal");
    const names = result.map((f) => f.name).toSorted();
    expect(names).toEqual(["AGENTS.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md"]);
    expect(names).not.toContain("PROJECT.md");
  });

  it("drops hook-loaded extras at 'standard' tier", () => {
    // Main session so the privacy filter leaves the set intact — this case is
    // about the tier allowlist rejecting hook extras, nothing else.
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "standard");
    expect(result).toHaveLength(STANDARD_FILES.length);
    expect(result.map((f) => f.name)).not.toContain("PROJECT.md");
  });

  it("returns minimal files when tierOverride is 'minimal' for main session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "minimal");
    const names = result.map((f) => f.name);
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("TOOLS.md");
    expect(names).toContain("SOUL.md");
    expect(names).not.toContain("HEARTBEAT.md");
    expect(names).not.toContain("PROJECT.md");
  });

  it("returns all files including extras when tierOverride is 'full'", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "full");
    expect(result).toHaveLength(ALL_FILES.length);
    expect(result.map((f) => f.name)).toContain("PROJECT.md");
    expect(result.map((f) => f.name)).toContain("CONVENTIONS.md");
  });

  it("standard tier excludes extra files, full tier includes them", () => {
    const standard = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "standard");
    const full = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "full");
    expect(full.length).toBeGreaterThan(standard.length);
    expect(full.length - standard.length).toBe(EXTRA_FILES.length);
  });

  it("standard tier excludes hook-sourced files even when basename matches the root allowlist", () => {
    // Regression: previously the standard-tier filter matched only on basename,
    // so an extra like `packages/core/AGENTS.md` slipped through alongside the
    // root AGENTS.md and rendered standard indistinguishable from full.
    const rootAgents = makeFile("AGENTS.md");
    const hookAgents = makeHookFile("AGENTS.md", "packages/core/AGENTS.md");
    const hookSoul = makeHookFile("SOUL.md", "packages/persona/SOUL.md");
    const files = [rootAgents, hookAgents, hookSoul];

    const standard = filterBootstrapFilesForSession(files, MAIN_KEY, "standard");
    expect(standard).toHaveLength(1);
    expect(standard[0]?.path).toBe("/workspace/AGENTS.md");
    expect(standard[0]?.source).toBe("root");

    const full = filterBootstrapFilesForSession(files, MAIN_KEY, "full");
    expect(full).toHaveLength(3);
  });

  it("minimal tier excludes hook-sourced files even when basename matches the allowlist", () => {
    // Same regression as the standard-tier guard above, but for the explicit
    // `minimal` tier override: a hook-loaded `packages/api/AGENTS.md` must NOT
    // slip in just because its basename is in MINIMAL_BOOTSTRAP_ALLOWLIST.
    // Without this guard, `minimal` could return more files than `standard`
    // for the same input, breaking the `minimal ⊂ standard ⊂ full` inclusion
    // expected by callers.
    const rootAgents = makeFile("AGENTS.md");
    const rootTools = makeFile("TOOLS.md");
    const rootSoul = makeFile("SOUL.md");
    const rootIdentity = makeFile("IDENTITY.md");
    const rootUser = makeFile("USER.md");
    const hookAgents = makeHookFile("AGENTS.md", "packages/api/AGENTS.md");
    const hookAgentsWeb = makeHookFile("AGENTS.md", "packages/web/AGENTS.md");
    const files = [
      rootAgents,
      rootTools,
      rootSoul,
      rootIdentity,
      rootUser,
      hookAgents,
      hookAgentsWeb,
    ];

    const minimal = filterBootstrapFilesForSession(files, SUBAGENT_KEY, "minimal");
    expect(minimal).toHaveLength(5);
    for (const file of minimal) {
      expect(file.source).toBe("root");
    }
    expect(minimal.map((f) => f.name).toSorted()).toEqual([
      "AGENTS.md",
      "IDENTITY.md",
      "SOUL.md",
      "TOOLS.md",
      "USER.md",
    ]);

    // Inclusion check: every file the explicit `minimal` tier returns must
    // also be returned by the explicit `standard` and `full` tiers for the
    // same input set.
    const standard = filterBootstrapFilesForSession(files, MAIN_KEY, "standard");
    const full = filterBootstrapFilesForSession(files, MAIN_KEY, "full");
    const standardPaths = new Set(standard.map((f) => f.path));
    const fullPaths = new Set(full.map((f) => f.path));
    for (const file of minimal) {
      expect(standardPaths.has(file.path)).toBe(true);
      expect(fullPaths.has(file.path)).toBe(true);
    }
  });
});
