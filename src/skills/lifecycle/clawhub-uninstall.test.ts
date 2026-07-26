import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applyClawHubSkillUninstall, planClawHubSkillUninstall } from "./clawhub-uninstall.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const workspaceDir = tempDirs.make("openclaw-skill-uninstall-");
  const slug = "triage";
  const skillDir = join(workspaceDir, "skills", slug);
  const content = "---\nname: triage\n---\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const installedAt = 123;
  const registry = "https://clawhub.ai";
  await mkdir(join(skillDir, ".clawhub"), { recursive: true });
  await mkdir(join(workspaceDir, ".clawhub"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content);
  const fileTreeSha256 = await digestClawHubSkillTree(skillDir);
  await writeFile(
    join(skillDir, ".clawhub", "origin.json"),
    JSON.stringify({
      version: 1,
      registry,
      slug,
      installedVersion: "1.0.0",
      installedAt,
      skillFile: { path: "SKILL.md", sha256 },
      fileTreeSha256,
    }),
  );
  await writeFile(
    join(workspaceDir, ".clawhub", "lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        [slug]: {
          version: "1.0.0",
          registry,
          installedAt,
          skillFile: { path: "SKILL.md", sha256 },
          fileTreeSha256,
        },
      },
    }),
  );
  return { workspaceDir, slug, skillDir };
}

describe("ClawHub skill uninstall lifecycle", () => {
  it("plans and removes an unchanged tracked skill", async () => {
    const current = await fixture();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: current.slug,
      expectedVersion: "1.0.0",
    });
    expect(planned).toMatchObject({ ok: true, plan: { slug: "triage", version: "1.0.0" } });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    await expect(applyClawHubSkillUninstall(planned.plan)).resolves.toEqual({ ok: true });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).rejects.toThrow();
    const lock = JSON.parse(
      await readFile(join(current.workspaceDir, ".clawhub", "lock.json"), "utf8"),
    );
    expect(lock.skills).toEqual({});
  });

  it("retains a locally modified skill", async () => {
    const current = await fixture();
    await writeFile(join(current.skillDir, "SKILL.md"), "operator edit\n");
    await expect(
      planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: current.slug,
        expectedVersion: "1.0.0",
      }),
    ).resolves.toMatchObject({ ok: false, code: "modified" });
  });

  it("retains a skill with modified auxiliary files", async () => {
    const current = await fixture();
    await writeFile(join(current.skillDir, "script.js"), "operator addition\n");
    await expect(
      planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: current.slug,
        expectedVersion: "1.0.0",
      }),
    ).resolves.toMatchObject({ ok: false, code: "modified" });
  });

  it("restores the staged skill when lockfile untracking fails", async () => {
    const current = await fixture();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: current.slug,
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }

    await expect(
      applyClawHubSkillUninstall(planned.plan, {
        untrack: async () => {
          throw new Error("lockfile write failed");
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("lockfile write failed"),
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "name: triage",
    );
    const lock = JSON.parse(
      await readFile(join(current.workspaceDir, ".clawhub", "lock.json"), "utf8"),
    );
    expect(lock.skills.triage).toBeDefined();
  });
});
