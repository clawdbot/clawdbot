import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { CLAWHUB_SKILLS_SH_TRUST_STATE } from "../../infra/clawhub.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { applyClawHubSkillUninstall, planClawHubSkillUninstall } from "./clawhub-uninstall.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetGlobalHookRunner());

async function fixture(ownerHandle?: string, requestedReference?: string) {
  const workspaceDir = tempDirs.make("openclaw-skill-uninstall-");
  const slug = "triage";
  const skillDir = join(workspaceDir, "skills", slug);
  const content = "---\nname: triage\ndescription: Triage incidents\nversion: 0.9.0\n---\n";
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
      ...(ownerHandle ? { ownerHandle } : {}),
      ...(requestedReference
        ? { requestedReference, trustState: CLAWHUB_SKILLS_SH_TRUST_STATE }
        : {}),
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
          ...(ownerHandle ? { ownerHandle } : {}),
          ...(requestedReference
            ? { requestedReference, trustState: CLAWHUB_SKILLS_SH_TRUST_STATE }
            : {}),
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
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
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

  it("plans an owner-qualified tracked skill by its local slug", async () => {
    const current = await fixture("acme");
    await expect(
      planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: "@acme/triage",
        expectedVersion: "1.0.0",
      }),
    ).resolves.toMatchObject({
      ok: true,
      plan: { requestedRef: "@acme/triage", slug: "triage", version: "1.0.0" },
    });
  });

  it("rejects an owner-qualified reference that does not own the tracked skill", async () => {
    const current = await fixture("other");
    await expect(
      planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: "@acme/triage",
        expectedVersion: "1.0.0",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "ambiguous",
      error: expect.stringContaining("tracked as @other/triage"),
    });
  });

  it("retains a replacement installed by another owner after planning", async () => {
    const current = await fixture("acme");
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: "@acme/triage",
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    const originPath = join(current.skillDir, ".clawhub", "origin.json");
    const lockPath = join(current.workspaceDir, ".clawhub", "lock.json");
    const origin = JSON.parse(await readFile(originPath, "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    origin.ownerHandle = "other";
    lock.skills.triage.ownerHandle = "other";
    await writeFile(originPath, JSON.stringify(origin));
    await writeFile(lockPath, JSON.stringify(lock));

    await expect(applyClawHubSkillUninstall(planned.plan)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("tracked as @other/triage"),
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "name: triage",
    );
    const retainedLock = JSON.parse(await readFile(lockPath, "utf8"));
    expect(retainedLock.skills.triage.ownerHandle).toBe("other");
  });

  it("preserves the full skills.sh reference when revalidating removal", async () => {
    const requestedReference = "skills-sh:acme/triage-repo/triage";
    const replacementReference = "skills-sh:other/replacement-repo/triage";
    const current = await fixture(undefined, requestedReference);
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: requestedReference,
      expectedVersion: "1.0.0",
    });
    expect(planned).toMatchObject({
      ok: true,
      plan: { requestedRef: requestedReference, slug: "triage" },
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }

    const originPath = join(current.skillDir, ".clawhub", "origin.json");
    const lockPath = join(current.workspaceDir, ".clawhub", "lock.json");
    const origin = JSON.parse(await readFile(originPath, "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    origin.requestedReference = replacementReference;
    lock.skills.triage.requestedReference = replacementReference;
    await writeFile(originPath, JSON.stringify(origin));
    await writeFile(lockPath, JSON.stringify(lock));

    await expect(applyClawHubSkillUninstall(planned.plan)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(replacementReference),
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
