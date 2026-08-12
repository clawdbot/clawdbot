// Sandbox skill input tests cover snapshot suppression and synced skill workspace selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo, escapeSkillXml } from "../../skills/loading/skill-contract.js";
import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

const hostSkillPath = "/usr/lib/node_modules/openclaw/skills/demo/SKILL.md";
const hostSkillBaseDir = "/usr/lib/node_modules/openclaw/skills/demo";
const snapshot: SkillSnapshot = {
  prompt:
    "<available_skills><skill><location>/usr/lib/node_modules/openclaw/skills/demo/SKILL.md</location></skill></available_skills>",
  skills: [{ name: "demo" }],
  resolvedSkills: [
    {
      name: "demo",
      description: "Demo skill",
      filePath: hostSkillPath,
      baseDir: hostSkillBaseDir,
      source: "openclaw-bundled",
      sourceInfo: createSyntheticSourceInfo(hostSkillPath, {
        source: "openclaw-bundled",
        baseDir: hostSkillBaseDir,
      }),
      disableModelInvocation: false,
    },
  ],
};

describe("resolveSandboxSkillRuntimeInputs", () => {
  it("keeps snapshots for non-sandboxed runs", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsSnapshot: snapshot,
      skillsPromptWorkspaceDir: "/workspace",
      skillsWorkspaceDir: "/workspace",
      workspaceOnly: false,
    });
  });

  it("uses the materialized skills workspace and drops host-path snapshots for sandboxes", () => {
    const skillsEligibility = {
      remote: {
        platforms: ["linux"],
        hasBin: () => true,
        hasAnyBin: () => true,
        note: "sandbox",
      },
    };

    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsEligibility,
          skillsWorkspaceDir: "/state/sandbox-skills",
          workspaceAccess: "rw",
        },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsEligibility,
      skillsSnapshot: undefined,
      skillsPromptWorkspaceDir: "/workspace/.openclaw/sandbox-skills",
      skillsWorkspaceDir: "/state/sandbox-skills",
      workspaceOnly: true,
    });
  });

  it("keeps the sync-published materialized catalog and remaps prompt paths for sandboxes", () => {
    const materializedSnapshot: SkillSnapshot = {
      prompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n    <description>Demo skill</description>\n    <location>/state/sandbox-skills/skills/demo/SKILL.md</location>\n  </skill>\n</available_skills>",
      skills: [{ name: "demo", skillKey: "demo" }],
      resolvedSkills: [
        {
          name: "demo",
          description: "Demo skill",
          filePath: "/state/sandbox-skills/skills/demo/SKILL.md",
          baseDir: "/state/sandbox-skills/skills/demo",
          source: "openclaw-workspace",
          sourceInfo: createSyntheticSourceInfo("/state/sandbox-skills/skills/demo/SKILL.md", {
            source: "openclaw-workspace",
            baseDir: "/state/sandbox-skills/skills/demo",
          }),
          disableModelInvocation: false,
        },
      ],
      version: 7,
    };

    const resolved = resolveSandboxSkillRuntimeInputs({
      sandbox: {
        enabled: true,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir: "/state/sandbox-skills",
        skillsSnapshot: materializedSnapshot,
        workspaceAccess: "rw",
      },
      effectiveWorkspace: "/workspace",
      skillsSnapshot: snapshot,
    });

    expect(resolved.skillsSnapshot?.skills).toEqual(materializedSnapshot.skills);
    expect(resolved.skillsSnapshot?.prompt).toContain(
      "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
    );
    expect(resolved.skillsSnapshot?.prompt).not.toContain(hostSkillPath);
    expect(resolved.skillsSnapshot?.resolvedSkills?.[0]?.filePath).toBe(
      "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
    );
    expect(resolved.skillsPromptWorkspaceDir).toBe("/workspace/.openclaw/sandbox-skills");
    expect(resolved.skillsWorkspaceDir).toBe("/state/sandbox-skills");
    expect(resolved.workspaceOnly).toBe(true);
  });

  it("remaps XML-escaped special-character locations in published sandbox catalogs", () => {
    const hostFilePath = "/state/sandbox-skills/skills/demo&alpha/SKILL.md";
    const hostBaseDir = "/state/sandbox-skills/skills/demo&alpha";
    const containerFilePath = "/workspace/.openclaw/sandbox-skills/skills/demo&alpha/SKILL.md";
    const materializedSnapshot: SkillSnapshot = {
      prompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo&amp;alpha</name>",
        "    <description>Demo &amp; alpha</description>",
        `    <location>${escapeSkillXml(hostFilePath)}</location>`,
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      skills: [{ name: "demo&alpha", skillKey: "demo&alpha" }],
      resolvedSkills: [
        {
          name: "demo&alpha",
          description: "Demo & alpha",
          filePath: hostFilePath,
          baseDir: hostBaseDir,
          source: "openclaw-workspace",
          sourceInfo: createSyntheticSourceInfo(hostFilePath, {
            source: "openclaw-workspace",
            baseDir: hostBaseDir,
          }),
          disableModelInvocation: false,
        },
      ],
      version: 8,
    };

    const resolved = resolveSandboxSkillRuntimeInputs({
      sandbox: {
        enabled: true,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir: "/state/sandbox-skills",
        skillsSnapshot: materializedSnapshot,
        workspaceAccess: "rw",
      },
      effectiveWorkspace: "/workspace",
      skillsSnapshot: snapshot,
    });
    const prompt = resolveSkillsPrompt({
      skillsSnapshot: resolved.skillsSnapshot,
      workspaceDir: resolved.skillsPromptWorkspaceDir,
    });

    expect(resolved.skillsSnapshot?.resolvedSkills?.[0]?.filePath).toBe(containerFilePath);
    expect(resolved.skillsSnapshot?.prompt).toContain(
      `<location>${escapeSkillXml(containerFilePath)}</location>`,
    );
    expect(resolved.skillsSnapshot?.prompt).not.toContain(escapeSkillXml(hostFilePath));
    expect(prompt).toContain(`<location>${escapeSkillXml(containerFilePath)}</location>`);
    expect(prompt).not.toContain("/state/sandbox-skills/");
    expect(prompt).not.toContain(hostSkillPath);
  });

  it("falls back to the effective workspace for older sandbox contexts", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: { enabled: true },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsSnapshot: undefined,
      skillsPromptWorkspaceDir: "/workspace",
      skillsWorkspaceDir: "/workspace",
      workspaceOnly: true,
    });
  });

  it("maps materialized read paths while preserving original file identities", () => {
    expect(
      mapSandboxSkillUsagePaths({
        paths: [
          {
            readPath: "/state/sandbox-skills/skills/demo/SKILL.md",
            skillFile: "/agent-workspace/skills/demo/SKILL.md",
            skillName: "demo",
            skillSource: "workspace",
          },
        ],
        skillsWorkspaceDir: "/state/sandbox-skills",
        skillsPromptWorkspaceDir: "/workspace/.openclaw/sandbox-skills",
      }),
    ).toEqual([
      {
        readPath: "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
        skillFile: "/agent-workspace/skills/demo/SKILL.md",
        skillName: "demo",
        skillSource: "workspace",
      },
    ]);
  });

  it("rebuilds sandbox prompts from materialized skill paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    try {
      const effectiveWorkspace = path.join(root, "workspace");
      const materializedWorkspace = path.join(root, "state", "sandbox-skills");
      const skillDir = path.join(materializedWorkspace, "skills", "demo");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: demo",
          "description: Demo skill",
          'openclaw: {"requires":{"anyBins":["sandboxbin"]}}',
          "---",
          "# Demo",
          "",
        ].join("\n"),
        "utf8",
      );
      const skillsEligibility = {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: (bins: string[]) => bins.includes("sandboxbin"),
          note: "sandbox",
        },
      };

      const {
        skillsEligibility: skillsEligibilityForRun,
        skillsPromptWorkspaceDir,
        skillsSnapshot: skillsSnapshotForRun,
        skillsWorkspaceDir,
        workspaceOnly,
      } = resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsEligibility,
          skillsWorkspaceDir: materializedWorkspace,
          workspaceAccess: "rw",
        },
        effectiveWorkspace,
        skillsSnapshot: snapshot,
      });
      const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
        workspaceDir: skillsWorkspaceDir,
        eligibility: skillsEligibilityForRun,
        skillsSnapshot: skillsSnapshotForRun,
        workspaceOnly,
      });
      const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
        entries: shouldLoadSkillEntries ? skillEntries : undefined,
        skillsWorkspaceDir,
        skillsPromptWorkspaceDir,
      });
      const prompt = resolveSkillsPrompt({
        skillsSnapshot: skillsSnapshotForRun,
        entries: promptSkillEntries,
        workspaceDir: skillsPromptWorkspaceDir,
        eligibility: skillsEligibilityForRun,
      });

      expect(prompt).toContain("/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md");
      expect(prompt.replaceAll("\\", "/")).not.toContain(
        materializedWorkspace.replaceAll("\\", "/"),
      );
      expect(prompt).not.toContain(hostSkillPath);
      expect(prompt).not.toContain("plugin-skills");
      expect(prompt.replaceAll("\\", "/")).not.toContain("/skills/canvas/SKILL.md");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves remote eligibility when rebuilding sandbox prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    try {
      const skillDir = path.join(root, "skills", "macskill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: macskill",
          "description: Mac-only remote skill",
          'openclaw: {"os":["darwin"]}',
          "---",
          "# Mac Skill",
          "",
        ].join("\n"),
        "utf8",
      );
      const skillsEligibility = {
        remote: {
          platforms: ["darwin"],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: "remote mac available",
        },
      };

      const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
        workspaceDir: root,
        eligibility: skillsEligibility,
        workspaceOnly: true,
      });
      const prompt = resolveSkillsPrompt({
        entries: shouldLoadSkillEntries ? skillEntries : undefined,
        workspaceDir: root,
        eligibility: skillsEligibility,
      });

      expect(prompt).toContain("remote mac available");
      expect(prompt).toContain("macskill");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
