import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  applyWorkspaceSkillMutation,
  isWorkspaceSkillMutationApplied,
  isWorkspaceSkillMutationRestored,
  prepareWorkspaceSkillMutation,
  prepareWorkspaceSkillRestoration,
  restoreWorkspaceSkillMutation,
} from "./workspace-skill-write.js";

const tempDirs = createTrackedTempDirs();
const symlinkPolicy = { allowWrites: false, allowedTargetRealPaths: [] };

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("workspace skill mutations", () => {
  it("removes support files when the activating SKILL.md write fails", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-skill-write-failure-");
    const skillDir = path.join(workspaceDir, "skills", "partial-create");
    const skillFile = path.join(skillDir, "SKILL.md");
    const supportFile = path.join(skillDir, "references", "proof.md");
    const mutation = await prepareWorkspaceSkillMutation({
      workspaceDir,
      skillDir,
      skillFile,
      content: "# Partial Create\n",
      supportFiles: [{ path: "references/proof.md", content: "new support\n" }],
      mode: "create",
      symlinkPolicy,
    });
    await fs.mkdir(skillFile, { recursive: true });

    await expect(applyWorkspaceSkillMutation(mutation)).rejects.toThrow();
    await expect(fs.access(supportFile)).rejects.toThrow();
    await expect(isWorkspaceSkillMutationRestored(mutation)).resolves.toBe(false);
  });

  it("restores the complete previous update bundle", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-skill-write-update-");
    const skillDir = path.join(workspaceDir, "skills", "reversible-update");
    const skillFile = path.join(skillDir, "SKILL.md");
    const supportFile = path.join(skillDir, "references", "proof.md");
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(skillFile, "# Before\n", "utf8");
    await fs.writeFile(supportFile, "before support\n", "utf8");
    const mutation = await prepareWorkspaceSkillMutation({
      workspaceDir,
      skillDir,
      skillFile,
      content: "# After\n",
      supportFiles: [{ path: "references/proof.md", content: "after support\n" }],
      mode: "update",
      symlinkPolicy,
    });

    await applyWorkspaceSkillMutation(mutation);
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# After\n");
    await expect(fs.readFile(supportFile, "utf8")).resolves.toBe("after support\n");

    await restoreWorkspaceSkillMutation(mutation);
    await expect(isWorkspaceSkillMutationRestored(mutation)).resolves.toBe(true);
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Before\n");
    await expect(fs.readFile(supportFile, "utf8")).resolves.toBe("before support\n");
  });

  it("removes a support file when its atomic write commits and then rejects", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-skill-support-commit-failure-");
    const skillDir = path.join(workspaceDir, "skills", "partial-support");
    const skillFile = path.join(skillDir, "SKILL.md");
    const supportFile = path.join(skillDir, "references", "proof.md");
    const mutation = await prepareWorkspaceSkillMutation({
      workspaceDir,
      skillDir,
      skillFile,
      content: "# Partial Support\n",
      supportFiles: [{ path: "references/proof.md", content: "new support\n" }],
      mode: "create",
      symlinkPolicy,
    });
    await expect(
      applyWorkspaceSkillMutation(mutation, async (file) => {
        const targetPath = path.join(file.rootDir, file.relativePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, file.content, "utf8");
        if (targetPath === supportFile) {
          throw new Error("injected post-commit write failure");
        }
      }),
    ).rejects.toThrow("injected post-commit write failure");
    await expect(fs.access(skillFile)).rejects.toThrow();
    await expect(fs.access(supportFile)).rejects.toThrow();
    await expect(isWorkspaceSkillMutationRestored(mutation)).resolves.toBe(true);
  });

  it("restores an update when the SKILL.md write commits and then rejects", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-skill-main-commit-failure-");
    const skillDir = path.join(workspaceDir, "skills", "partial-main");
    const skillFile = path.join(skillDir, "SKILL.md");
    const supportFile = path.join(skillDir, "references", "proof.md");
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(skillFile, "# Before\n", "utf8");
    await fs.writeFile(supportFile, "before support\n", "utf8");
    const mutation = await prepareWorkspaceSkillMutation({
      workspaceDir,
      skillDir,
      skillFile,
      content: "# After\n",
      supportFiles: [{ path: "references/proof.md", content: "after support\n" }],
      mode: "update",
      symlinkPolicy,
    });
    await expect(
      applyWorkspaceSkillMutation(mutation, async (file) => {
        const targetPath = path.join(file.rootDir, file.relativePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, file.content, "utf8");
        if (targetPath === skillFile) {
          throw new Error("injected post-commit write failure");
        }
      }),
    ).rejects.toThrow("injected post-commit write failure");
    await expect(isWorkspaceSkillMutationRestored(mutation)).resolves.toBe(true);
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Before\n");
    await expect(fs.readFile(supportFile, "utf8")).resolves.toBe("before support\n");
  });

  it("removes every file from a restored create mutation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-skill-write-create-");
    const skillDir = path.join(workspaceDir, "skills", "reversible-create");
    const skillFile = path.join(skillDir, "SKILL.md");
    const supportFile = path.join(skillDir, "references", "proof.md");
    const mutation = await prepareWorkspaceSkillMutation({
      workspaceDir,
      skillDir,
      skillFile,
      content: "# Created\n",
      supportFiles: [{ path: "references/proof.md", content: "created support\n" }],
      mode: "create",
      symlinkPolicy,
    });

    await applyWorkspaceSkillMutation(mutation);
    await restoreWorkspaceSkillMutation(mutation);

    await expect(fs.access(skillFile)).rejects.toThrow();
    await expect(fs.access(supportFile)).rejects.toThrow();
  });

  it("restores an interrupted update from persisted rollback facts", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-skill-recovery-");
    const skillDir = path.join(workspaceDir, "skills", "recovered-update");
    const skillFile = path.join(skillDir, "SKILL.md");
    const supportFile = path.join(skillDir, "references", "proof.md");
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(skillFile, "# Partial update\n", "utf8");
    await fs.writeFile(supportFile, "partial support\n", "utf8");

    const restoration = await prepareWorkspaceSkillRestoration({
      workspaceDir,
      skillDir,
      skillFile,
      previousContent: "# Before\n",
      proposedContentHash: sha256Hex("# Partial update\n"),
      supportFiles: [
        {
          path: "references/proof.md",
          previousContent: "before support\n",
          proposedContentHash: sha256Hex("partial support\n"),
        },
      ],
      mode: "update",
      symlinkPolicy,
    });
    await restoreWorkspaceSkillMutation(restoration);

    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Before\n");
    await expect(fs.readFile(supportFile, "utf8")).resolves.toBe("before support\n");
  });

  it("detects external edits before restoring a completed mutation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-skill-external-edit-");
    const skillDir = path.join(workspaceDir, "skills", "external-edit");
    const skillFile = path.join(skillDir, "SKILL.md");
    const mutation = await prepareWorkspaceSkillMutation({
      workspaceDir,
      skillDir,
      skillFile,
      content: "# Proposed\n",
      mode: "create",
      symlinkPolicy,
    });

    await applyWorkspaceSkillMutation(mutation);
    await expect(isWorkspaceSkillMutationApplied(mutation)).resolves.toBe(true);
    await fs.writeFile(skillFile, "# External edit\n", "utf8");
    await expect(isWorkspaceSkillMutationApplied(mutation)).resolves.toBe(false);
    await expect(restoreWorkspaceSkillMutation(mutation)).rejects.toThrow(
      "Failed to restore the previous workspace skill state.",
    );
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# External edit\n");
  });
});
