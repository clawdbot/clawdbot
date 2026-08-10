import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadBundleAgentTemplates } from "./bundle-agent-manifest.js";
import { loadBundleManifest } from "./bundle-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeBundleRoot(): string {
  return fs.realpathSync(tempDirs.make("openclaw-bundle-agents-"));
}

function writeAgent(rootDir: string, relativePath: string, content: string): string {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("loadBundleAgentTemplates", () => {
  it("normalizes Claude agent frontmatter without persisting prompt text", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      "agents/reviewer.md",
      [
        "---",
        "name: reviewer",
        "description: Reviews changes for correctness and security",
        "model: sonnet",
        "effort: high",
        "maxTurns: 12",
        "tools: [Read, Grep, Bash]",
        "disallowedTools: [Write, Edit]",
        "skills: [security-review]",
        "memory: project",
        "background: true",
        "isolation: worktree",
        "permissionMode: plan",
        "---",
        "Review the requested change and return prioritized findings.",
      ].join("\n"),
    );

    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: ["agents"],
      sourceFormat: "claude",
      pluginId: "review-pack",
      rejectHardlinks: true,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.agentTemplates).toEqual([
      expect.objectContaining({
        id: "review-pack:reviewer",
        pluginId: "review-pack",
        sourceFormat: "claude",
        name: "reviewer",
        description: "Reviews changes for correctness and security",
        prompt: {
          kind: "file",
          path: "agents/reviewer.md",
          contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        sourceFilePath: "agents/reviewer.md",
        model: "sonnet",
        effort: "high",
        maxTurns: 12,
        tools: ["Read", "Grep", "Bash"],
        disallowedTools: ["Write", "Edit"],
        skills: ["security-review"],
        memory: "project",
        background: true,
        isolation: "worktree",
        unsupportedFields: [
          {
            field: "permissionMode",
            reason: "not mapped to OpenClaw runtime policy",
          },
        ],
      }),
    ]);
    expect(JSON.stringify(result.agentTemplates)).not.toContain("prioritized findings");
  });

  it("preserves a quoted scalar description that begins with a bracket", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      "agents/security-reviewer.md",
      [
        "---",
        "name: security-reviewer",
        'description: "[Security] Reviews changes"',
        "---",
        "Review safely.",
      ].join("\n"),
    );

    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: ["agents"],
      sourceFormat: "claude",
      pluginId: "quoted-pack",
      rejectHardlinks: true,
    });

    expect(result.agentTemplates).toMatchObject([
      { name: "security-reviewer", description: "[Security] Reviews changes" },
    ]);
  });

  it("rejects a Claude agent name outside the source format contract", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      "agents/invalid.md",
      ["---", "name: Security Reviewer", "description: Invalid name", "---", "Review."].join("\n"),
    );

    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: ["agents"],
      sourceFormat: "claude",
      pluginId: "invalid-name-pack",
      rejectHardlinks: true,
    });

    expect(result.agentTemplates).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("invalid Claude agent name") }),
    );
  });

  it("normalizes Cursor agent files from .cursor/agents", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      ".cursor/agents/explorer.md",
      [
        "---",
        "name: explorer",
        "description: Maps an unfamiliar repository",
        "tools: Read, Grep, Glob",
        "---",
        "Explore the repository without editing it.",
      ].join("\n"),
    );

    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: [".cursor/agents"],
      sourceFormat: "cursor",
      pluginId: "cursor-pack",
      rejectHardlinks: true,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.agentTemplates).toEqual([
      expect.objectContaining({
        id: "cursor-pack:explorer",
        pluginId: "cursor-pack",
        sourceFormat: "cursor",
        name: "explorer",
        description: "Maps an unfamiliar repository",
        tools: ["Read", "Grep", "Glob"],
      }),
    ]);
  });

  it("keeps a Cursor manifest-declared agents root owned by Cursor", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      ".cursor-plugin/plugin.json",
      JSON.stringify({ name: "cursor-team-kit", agents: "./agents/" }),
    );
    writeAgent(
      rootDir,
      "agents/ci-watcher.md",
      [
        "---",
        "name: ci-watcher",
        "description: Watches CI until completion",
        "---",
        "Monitor CI and report failures.",
      ].join("\n"),
    );

    const result = loadBundleManifest({
      rootDir,
      bundleFormat: "cursor",
      loadAgentTemplates: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected Cursor bundle manifest to load");
    }
    expect(result.manifest.agentTemplates).toMatchObject([
      { name: "ci-watcher", sourceFormat: "cursor" },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("preserves Claude agent metadata when Codex is the preferred bundle format", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      ".codex-plugin/plugin.json",
      JSON.stringify({ name: "mixed-pack", version: "1.0.0" }),
    );
    writeAgent(
      rootDir,
      "agents/reviewer.md",
      ["---", "name: reviewer", "description: Claude reviewer", "---", "Review changes."].join(
        "\n",
      ),
    );

    const result = loadBundleManifest({
      rootDir,
      bundleFormat: "codex",
      loadAgentTemplates: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected mixed bundle manifest to load");
    }
    expect(result.manifest.bundleFormat).toBe("codex");
    expect(result.manifest.agentTemplates).toEqual([
      expect.objectContaining({ name: "reviewer", sourceFormat: "claude" }),
    ]);
  });

  it("keeps the general manifest load shallow unless metadata is requested", () => {
    const rootDir = makeBundleRoot();
    writeAgent(rootDir, ".claude-plugin/plugin.json", JSON.stringify({ name: "discovery-pack" }));
    writeAgent(
      rootDir,
      "agents/reviewer.md",
      ["---", "name: reviewer", "description: Reviewer", "---", "Review changes."].join("\n"),
    );

    const result = loadBundleManifest({
      rootDir,
      bundleFormat: "claude",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected bundle manifest to load for discovery");
    }
    expect(result.manifest.agentTemplates).toBeUndefined();
  });

  it("skips malformed or incomplete agents and returns diagnostics", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      "agents/malformed.md",
      ["---", "name: malformed", "description: [unterminated", "Prompt body."].join("\n"),
    );
    writeAgent(
      rootDir,
      "agents/missing-description.md",
      ["---", "name: missing-description", "---", "Prompt body."].join("\n"),
    );

    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: ["agents"],
      sourceFormat: "claude",
      pluginId: "broken-pack",
      rejectHardlinks: true,
    });

    expect(result.agentTemplates).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("frontmatter") }),
        expect.objectContaining({ message: expect.stringContaining("description") }),
      ]),
    );
  });

  it("reports a manifest-declared agent root that cannot be inspected", () => {
    const rootDir = makeBundleRoot();
    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: ["missing-agents"],
      sourceFormat: "claude",
      pluginId: "missing-root-pack",
      rejectHardlinks: true,
    });

    expect(result.agentTemplates).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("could not be inspected") }),
    );
  });

  it("rejects declared agent roots outside the bundle", () => {
    const rootDir = makeBundleRoot();
    const outsideDir = makeBundleRoot();
    writeAgent(
      outsideDir,
      "reviewer.md",
      ["---", "name: reviewer", "description: Escaped agent", "---", "Do not load."].join("\n"),
    );

    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: [path.relative(rootDir, outsideDir)],
      sourceFormat: "claude",
      pluginId: "unsafe-pack",
      rejectHardlinks: true,
    });

    expect(result.agentTemplates).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("escapes the plugin root") }),
    );
  });

  it("skips oversized files without dropping safe siblings", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      "agents/oversized.md",
      ["---", "name: oversized", "description: Too large", "---", "x".repeat(1024 * 1024)].join(
        "\n",
      ),
    );
    writeAgent(
      rootDir,
      "agents/reviewer.md",
      ["---", "name: reviewer", "description: Safe sibling", "---", "Review."].join("\n"),
    );

    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: ["agents"],
      sourceFormat: "claude",
      pluginId: "large-pack",
      rejectHardlinks: true,
    });

    expect(result.agentTemplates.map((entry) => entry.name)).toEqual(["reviewer"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("exceeds the size limit") }),
    );
  });

  it("preserves Claude plugin subfolder identity when names repeat", () => {
    const rootDir = makeBundleRoot();
    for (const relativePath of ["agents/reviewer.md", "agents/nested/reviewer.md"]) {
      writeAgent(
        rootDir,
        relativePath,
        ["---", "name: reviewer", "description: Conflicting reviewer", "---", "Review."].join("\n"),
      );
    }

    const result = loadBundleAgentTemplates({
      rootDir,
      agentRoots: ["agents"],
      sourceFormat: "claude",
      pluginId: "collision-pack",
      rejectHardlinks: true,
    });

    expect(result.agentTemplates).toMatchObject([
      { id: "collision-pack:nested:reviewer", name: "reviewer" },
      { id: "collision-pack:reviewer", name: "reviewer" },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("drops cross-format definitions with the same scoped id", () => {
    const rootDir = makeBundleRoot();
    writeAgent(rootDir, ".claude-plugin/plugin.json", JSON.stringify({ name: "mixed-pack" }));
    for (const relativePath of ["agents/reviewer.md", "agents/nested/reviewer.md"]) {
      writeAgent(
        rootDir,
        relativePath,
        ["---", "name: reviewer", "description: Claude reviewer", "---", "Review."].join("\n"),
      );
    }
    writeAgent(
      rootDir,
      ".cursor/agents/reviewer.md",
      ["---", "name: reviewer", "description: Cursor reviewer", "---", "Explore."].join("\n"),
    );

    const result = loadBundleManifest({
      rootDir,
      bundleFormat: "claude",
      loadAgentTemplates: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected mixed bundle manifest to load");
    }
    expect(result.manifest.agentTemplates).toMatchObject([
      { id: "mixed-pack:nested:reviewer", sourceFormat: "claude" },
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("conflicting compatible") }),
    );
  });

  it("does not reinterpret native Agent Plugin directories as compatible templates", () => {
    const rootDir = makeBundleRoot();
    writeAgent(
      rootDir,
      "plugin.json",
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "portable-pack",
      }),
    );
    for (const relativePath of ["agents/reviewer.md", ".cursor/agents/explorer.md"]) {
      writeAgent(
        rootDir,
        relativePath,
        ["---", "name: reviewer", "description: Metadata", "---", "Prompt."].join("\n"),
      );
    }

    const result = loadBundleManifest({ rootDir, bundleFormat: "agent" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected Agent Plugin manifest to load");
    }
    expect(result.manifest.agentTemplates).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps default agents visible when an optional secondary manifest is malformed", () => {
    const rootDir = makeBundleRoot();
    writeAgent(rootDir, ".codex-plugin/plugin.json", JSON.stringify({ name: "codex-pack" }));
    writeAgent(rootDir, ".claude-plugin/plugin.json", "{ malformed");
    writeAgent(
      rootDir,
      "agents/reviewer.md",
      ["---", "name: reviewer", "description: Default agent", "---", "Review."].join("\n"),
    );

    const result = loadBundleManifest({
      rootDir,
      bundleFormat: "codex",
      loadAgentTemplates: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected Codex bundle manifest to load");
    }
    expect(result.manifest.agentTemplates).toMatchObject([
      { name: "reviewer", sourceFormat: "claude" },
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("failed to parse") }),
    );
  });
});
