import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { applyClawHubSkillUninstall, planClawHubSkillUninstall } from "./clawhub-uninstall.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetGlobalHookRunner());

async function fixture() {
  const workspaceDir = tempDirs.make("openclaw-skill-uninstall-");
  const slug = "triage";
  const skillDir = join(workspaceDir, "skills", slug);
  const content = "---\nname: triage\ndescription: Triage incidents\nversion: 0.9.0\n---\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const installedAt = 123;
  const registry = "https://clawhub.ai";
  const ownerHandle = "owner";
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
      ownerHandle,
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
          ownerHandle,
          skillFile: { path: "SKILL.md", sha256 },
          fileTreeSha256,
        },
      },
    }),
  );
  return {
    workspaceDir,
    slug,
    skillDir,
    originPath: join(skillDir, ".clawhub", "origin.json"),
    lockPath: join(workspaceDir, ".clawhub", "lock.json"),
  };
}

async function replaceTrackedOwner(
  current: Awaited<ReturnType<typeof fixture>>,
  ownerHandle: string,
) {
  const origin = JSON.parse(await readFile(current.originPath, "utf8")) as {
    ownerHandle: string;
  };
  origin.ownerHandle = ownerHandle;
  await writeFile(current.originPath, JSON.stringify(origin));

  const lock = JSON.parse(await readFile(current.lockPath, "utf8")) as {
    skills: Record<string, { ownerHandle: string }>;
  };
  lock.skills[current.slug]!.ownerHandle = ownerHandle;
  await writeFile(current.lockPath, JSON.stringify(lock));
}

describe("ClawHub skill uninstall lifecycle", () => {
  it("plans and removes an unchanged tracked skill", async () => {
    const current = await fixture();
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: current.slug,
      expectedVersion: "1.0.0",
    });
    expect(planned).toMatchObject({
      ok: true,
      plan: { requestedRef: "triage", slug: "triage", version: "1.0.0" },
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    await expect(applyClawHubSkillUninstall(planned.plan)).resolves.toEqual({ ok: true });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).rejects.toThrow();
    const lock = JSON.parse(
      await readFile(join(current.workspaceDir, ".clawhub", "lock.json"), "utf8"),
    );
    expect(lock.skills).toEqual({});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      action: "removed",
      source: "clawhub",
      before: {
        name: "triage",
        skillKey: "triage",
        description: "Triage incidents",
        source: "clawhub",
        revision: {
          declaredVersion: "0.9.0",
          sourceVersion: "1.0.0",
          contentSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          treeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("removes an owner-qualified tracked skill by its local slug", async () => {
    const current = await fixture();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: "@owner/triage",
      expectedVersion: "1.0.0",
    });

    expect(planned).toMatchObject({
      ok: true,
      plan: { requestedRef: "@owner/triage", slug: "triage", version: "1.0.0" },
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    await expect(applyClawHubSkillUninstall(planned.plan)).resolves.toEqual({ ok: true });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).rejects.toThrow();
    const lock = JSON.parse(await readFile(current.lockPath, "utf8")) as {
      skills: Record<string, unknown>;
    };
    expect(lock.skills).toEqual({});
  });

  it("rejects an owner-qualified ref for a different tracked publisher", async () => {
    const current = await fixture();

    await expect(
      planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: "@other/triage",
        expectedVersion: "1.0.0",
      }),
    ).resolves.toEqual({
      ok: false,
      code: "ambiguous",
      error: 'Skill "triage" is tracked as @owner/triage, not @other/triage.',
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "name: triage",
    );
    const lock = JSON.parse(await readFile(current.lockPath, "utf8")) as {
      skills: Record<string, unknown>;
    };
    expect(lock.skills.triage).toBeDefined();
  });

  it("revalidates the requested publisher before applying removal", async () => {
    const current = await fixture();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: "@owner/triage",
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    await replaceTrackedOwner(current, "other");

    await expect(applyClawHubSkillUninstall(planned.plan)).resolves.toEqual({
      ok: false,
      error: 'Skill "triage" is tracked as @other/triage, not @owner/triage.',
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "name: triage",
    );
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
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
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
    expect(handler).not.toHaveBeenCalled();
  });
});
