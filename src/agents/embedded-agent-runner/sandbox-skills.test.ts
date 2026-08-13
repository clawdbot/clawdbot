// Sandbox skill input tests cover snapshot suppression and synced skill workspace selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createSyntheticSourceInfo,
  escapeSkillXml,
  formatSkillsForPromptCore,
} from "../../skills/loading/skill-contract.js";
import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { syncWorkspaceSkills } from "../../skills/loading/workspace-skill-sync.runtime.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION, type SkillSnapshot } from "../../skills/types.js";
import { attachPublishedSandboxSkills } from "../sandbox/published-skills-handoff.js";
import {
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

vi.mock("../../skills/loading/plugin-skills.js", () => ({
  resolvePluginSkillDirs: () => [],
}));

function bindPublishedSandboxSnapshot(owner: object, skillsSnapshot: SkillSnapshot): void {
  attachPublishedSandboxSkills(owner, skillsSnapshot);
}

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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  // The materialized skills dir normally lives under the state dir inside $HOME,
  // where the renderer compacts locations to "~/…". Cover both roots: a prompt
  // that keeps a host "~/…" location is unreadable inside the container.
  it.each([
    { label: "for sandboxes", underHome: false },
    { label: "for sandboxes rooted in the user home", underHome: true },
  ])(
    "keeps the sync-published materialized catalog and remaps prompt paths $label",
    async ({ underHome }) => {
      const homeRoot = await fs.realpath(tempDirs.make("openclaw-sandbox-skills-home-"));
      if (underHome) {
        vi.stubEnv("HOME", homeRoot);
      }
      const root = underHome
        ? homeRoot
        : await fs.realpath(tempDirs.make("openclaw-sandbox-skills-remap-"));
      const sourceWorkspace = path.join(root, "source");
      const targetWorkspace = path.join(root, "state", "sandbox-skills");
      const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
      const managedSkillsDir = path.join(sourceWorkspace, ".managed");
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", "demo"),
        name: "demo",
        description: "Demo skill",
      });
      const synced = await syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir,
        managedSkillsDir,
        pluginSkillsDir: path.join(sourceWorkspace, ".plugin-skills"),
      });

      const sandbox = {
        enabled: true as const,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir: targetWorkspace,
        workspaceAccess: "rw" as const,
      };
      bindPublishedSandboxSnapshot(sandbox, synced.skillsSnapshot);
      const resolved = resolveSandboxSkillRuntimeInputs({
        sandbox,
        effectiveWorkspace: path.join(root, "workspace"),
        skillsSnapshot: snapshot,
      });

      const remappedDemo = resolved.skillsSnapshot?.resolvedSkills?.find(
        (skill) => skill.name === "demo",
      );
      const publishedDirName = path.basename(
        path.dirname(
          synced.skillsSnapshot.resolvedSkills?.find((skill) => skill.name === "demo")?.filePath ??
            "",
        ),
      );
      const containerSkillPath = `/workspace/.openclaw/sandbox-skills/skills/${publishedDirName}/SKILL.md`;
      expect(resolved.skillsSnapshot?.skills.map((skill) => skill.name)).toContain("demo");
      expect(remappedDemo?.filePath).toBe(containerSkillPath);
      expect(resolved.skillsSnapshot?.prompt).toContain(
        `<location>${containerSkillPath}</location>`,
      );
      expect(resolved.skillsSnapshot?.prompt).not.toContain("~/");
      expect(resolved.skillsSnapshot?.prompt).not.toContain(hostSkillPath);
      expect(resolved.skillsPromptWorkspaceDir).toBe("/workspace/.openclaw/sandbox-skills");
      expect(resolved.skillsWorkspaceDir).toBe(targetWorkspace);
      expect(resolved.workspaceOnly).toBe(true);
    },
  );

  it("remaps XML-escaped special-character locations in published sandbox catalogs", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-sandbox-skills-xml-"));
    const sourceWorkspace = path.join(root, "source");
    const targetWorkspace = path.join(root, "state", "sandbox-skills");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const skillDirName = "demo&alpha";
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", skillDirName),
      name: "demoalpha",
      description: "Demo and alpha",
    });
    const synced = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      pluginSkillsDir: path.join(sourceWorkspace, ".plugin-skills"),
    });
    const hostFilePath =
      synced.skillsSnapshot.resolvedSkills?.find((skill) => skill.name === "demoalpha")?.filePath ??
      "";
    const sandbox = {
      enabled: true as const,
      containerWorkdir: "/workspace",
      skillsWorkspaceDir: targetWorkspace,
      workspaceAccess: "rw" as const,
    };
    bindPublishedSandboxSnapshot(sandbox, synced.skillsSnapshot);
    const resolved = resolveSandboxSkillRuntimeInputs({
      sandbox,
      effectiveWorkspace: path.join(root, "workspace"),
      skillsSnapshot: snapshot,
    });
    const prompt = resolveSkillsPrompt({
      skillsSnapshot: resolved.skillsSnapshot,
      workspaceDir: resolved.skillsPromptWorkspaceDir,
    });

    const remappedSkill = resolved.skillsSnapshot?.resolvedSkills?.find((skill) =>
      skill.filePath.includes(`/${skillDirName}-`),
    );
    const containerFilePath = remappedSkill?.filePath ?? "";

    expect(containerFilePath).toContain(`/${skillDirName}-`);
    expect(containerFilePath).toContain("/SKILL.md");
    expect(resolved.skillsSnapshot?.prompt).toContain(
      `<location>${escapeSkillXml(containerFilePath)}</location>`,
    );
    expect(resolved.skillsSnapshot?.prompt).not.toContain(escapeSkillXml(hostFilePath));
    expect(prompt).toContain(`<location>${escapeSkillXml(containerFilePath)}</location>`);
    expect(prompt).not.toContain(escapeSkillXml(hostFilePath));
    expect(prompt).not.toContain(hostSkillPath);
  });

  it("does not rewrite description or location-note text that mentions the host skill path", () => {
    const targetWorkspace = "/state/sandbox-skills-prose-remap";
    const hostFilePath = `${targetWorkspace}/skills/demo/SKILL.md`;
    const containerFilePath = "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md";
    const description = `Host copy lives at ${hostFilePath}`;
    const locationNote = `Also documented at ${hostFilePath}`;
    const skill = {
      name: "demo",
      description,
      locationNote,
      filePath: hostFilePath,
      baseDir: `${targetWorkspace}/skills/demo`,
      source: "openclaw-workspace",
      sourceInfo: createSyntheticSourceInfo(hostFilePath, {
        source: "openclaw-workspace",
        baseDir: `${targetWorkspace}/skills/demo`,
      }),
      disableModelInvocation: false,
    };
    const skillsSnapshot = {
      prompt: formatSkillsForPromptCore([skill]),
      skills: [{ name: "demo" }],
      resolvedSkills: [skill],
      promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
    };

    const sandbox = {
      enabled: true as const,
      containerWorkdir: "/workspace",
      skillsWorkspaceDir: targetWorkspace,
      workspaceAccess: "rw" as const,
    };
    bindPublishedSandboxSnapshot(sandbox, skillsSnapshot);
    const resolved = resolveSandboxSkillRuntimeInputs({
      sandbox,
      effectiveWorkspace: "/workspace",
    });
    const prompt = resolved.skillsSnapshot?.prompt ?? "";

    expect(prompt).toContain(`<location>${escapeSkillXml(containerFilePath)}</location>`);
    expect(prompt).toContain(`<description>${escapeSkillXml(description)}</description>`);
    expect(prompt).toContain(`<location_note>${escapeSkillXml(locationNote)}</location_note>`);
    expect(prompt).not.toContain(`<location>${escapeSkillXml(hostFilePath)}</location>`);
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
