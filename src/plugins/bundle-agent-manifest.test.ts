import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBundleAgentTemplates } from "./bundle-agent-manifest.js";
import { loadBundleManifest } from "./bundle-manifest.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeBundleRoot(): string {
  const rootDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundle-agents-")),
  );
  tempDirs.push(rootDir);
  return rootDir;
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
        id: "reviewer",
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
        id: "explorer",
        pluginId: "cursor-pack",
        sourceFormat: "cursor",
        name: "explorer",
        description: "Maps an unfamiliar repository",
        tools: ["Read", "Grep", "Glob"],
      }),
    ]);
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

    const result = loadBundleManifest({ rootDir, bundleFormat: "codex" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected mixed bundle manifest to load");
    }
    expect(result.manifest.bundleFormat).toBe("codex");
    expect(result.manifest.agentTemplates).toEqual([
      expect.objectContaining({ name: "reviewer", sourceFormat: "claude" }),
    ]);
  });

  it("allows discovery to skip the full agent metadata scan", () => {
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
      loadAgentTemplates: false,
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

  it("drops conflicting template ids instead of choosing one implicitly", () => {
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

    expect(result.agentTemplates).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("conflicting compatible") }),
    );
  });

  it("drops a cross-format template when the same id already conflicts within one format", () => {
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

    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected mixed bundle manifest to load");
    }
    expect(result.manifest.agentTemplates ?? []).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("conflicting compatible") }),
    );
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

    const result = loadBundleManifest({ rootDir, bundleFormat: "codex" });

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
