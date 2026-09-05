import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import type { CollectionBackupManifest } from "./collection-backup.js";
import { seedLegacyCollectionBackup } from "./collection-backup.test-support.js";
import { resolveSkillCollectionBackupRoot } from "./collection-paths.js";
import { restoreLatestSkillCollectionBackup } from "./collection-restore.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const dispatchChange = vi.hoisted(() => vi.fn(async (_event: { action: string }) => {}));
const snapshotArtifact = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lifecycle/skill-change-hook.js", () => ({
  hasCommittedSkillChangeHooks: () => true,
  snapshotCommittedSkillArtifactBestEffort: snapshotArtifact,
  dispatchCommittedSkillChangeBestEffort: dispatchChange,
}));

let state: OpenClawTestState;
let skillsRoot: string;
let backupRoot: string;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  skillsRoot = resolveWorkshopSkillsDir({}, "main", state.env);
  backupRoot = resolveSkillCollectionBackupRoot({}, "main", state.env);
  snapshotArtifact.mockReset();
  snapshotArtifact.mockResolvedValue(undefined);
  dispatchChange.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

async function writeSkill(relativeDir: string, body: string, name = path.basename(relativeDir)) {
  const file = path.join(skillsRoot, relativeDir, "SKILL.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "---\nname: " + name + "\ndescription: Procedure\n---\n\n" + body);
  return file;
}

function seedBackup(change: () => Promise<unknown>) {
  return seedLegacyCollectionBackup(skillsRoot, backupRoot, change);
}

function restore() {
  return restoreLatestSkillCollectionBackup({
    workspaceDir: skillsRoot,
    config: {},
    agentId: "main",
    env: state.env,
  });
}

describe("skill collection backup and restore", () => {
  it("restores updates and drops, removes review-created skills, and preserves later files", async () => {
    const updated = await writeSkill("updated", "# Original\n");
    await writeSkill("dropped", "# Dropped\n");
    await seedBackup(async () => {
      await writeSkill("updated", "# Changed\n");
      await fs.rm(path.join(skillsRoot, "dropped"), { recursive: true });
      await writeSkill("created", "# Created\n");
    });
    const later = await writeSkill("later", "# Later\n");
    const external = state.statePath("external.txt");
    await fs.writeFile(external, "outside Workshop");
    dispatchChange.mockClear();

    const result = await restore();

    expect(result.restored).toEqual(["dropped", "updated"]);
    expect(result.removed).toEqual(["created"]);
    await expect(fs.readFile(updated, "utf8")).resolves.toContain("# Original");
    await expect(fs.readFile(later, "utf8")).resolves.toContain("# Later");
    await expect(fs.readFile(external, "utf8")).resolves.toBe("outside Workshop");
    await expect(fs.access(path.join(skillsRoot, "created"))).rejects.toThrow();
    expect(dispatchChange.mock.calls.map(([event]) => event.action).toSorted()).toEqual([
      "created",
      "removed",
      "updated",
    ]);
  });

  it("restores grouped directories under their declared keys and rejects escaping manifests", async () => {
    const file = await writeSkill("group/folder", "# Grouped\n", "declared-name");
    const backupDir = await seedBackup(() => fs.rm(path.dirname(file), { recursive: true }));
    await expect(restore()).resolves.toMatchObject({ restored: ["declared-name"] });
    await expect(fs.readFile(file, "utf8")).resolves.toContain("# Grouped");
    expect(snapshotArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ skillKey: "declared-name" }),
    );

    const manifestFile = path.join(backupDir, "manifest.json");
    const original = await fs.readFile(manifestFile, "utf8");
    for (const invalidPath of [".", "../outside", path.resolve(skillsRoot, "outside")]) {
      const manifest = JSON.parse(original) as CollectionBackupManifest;
      manifest.skillDirs = [invalidPath];
      manifest.resultSkillDirs = [];
      manifest.resultSkillHashes = {};
      await fs.writeFile(manifestFile, JSON.stringify(manifest));
      await expect(restore()).rejects.toThrow("outside the Skill Workshop directory");
      await expect(fs.readFile(file, "utf8")).resolves.toContain("# Grouped");
    }
  });

  it.each(["after review", "during artifact capture"])(
    "preserves a manual edit made %s",
    async (when) => {
      const file = await writeSkill("procedure", "# Original\n");
      await seedBackup(() => writeSkill("procedure", "# Reviewed\n"));
      if (when === "after review") {
        await fs.appendFile(file, "Manual improvement\n");
      } else {
        snapshotArtifact.mockImplementationOnce(async () => {
          await fs.appendFile(file, "Manual improvement\n");
          return undefined;
        });
      }
      await expect(restore()).rejects.toThrow("changed after cleanup");
      await expect(fs.readFile(file, "utf8")).resolves.toContain("Manual improvement");
    },
  );

  it("keeps history-only backups read-only", async () => {
    const file = await writeSkill("procedure", "# Original\n");
    const backupDir = await seedBackup(() => writeSkill("procedure", "# Reviewed\n"));
    const manifestFile = path.join(backupDir, "manifest.json");
    const manifest = JSON.parse(
      await fs.readFile(manifestFile, "utf8"),
    ) as CollectionBackupManifest;
    manifest.restoreUnavailableReason = "Legacy ownership could not be established";
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await expect(restore()).rejects.toThrow("history-only");
    await expect(fs.readFile(file, "utf8")).resolves.toContain("# Reviewed");
  });

  it.each(["unchanged", "edited", "file-deleted", "subtree-deleted"])(
    "preserves a legacy backup with %s deep content when its digest cannot be verified",
    async (deepContent) => {
      const file = await writeSkill("procedure", "# Original\n");
      const backupDir = await seedBackup(() => writeSkill("procedure", "# Reviewed\n"));
      const savedSkill = path.join(backupDir, "skills", "procedure");
      const relative = path.join(
        "references",
        ...Array.from({ length: 16 }, (_, index) => "d" + index),
        "proof.txt",
      );
      const savedDeep = path.join(savedSkill, relative);
      const currentDeep = path.join(skillsRoot, "procedure", relative);
      await fs.mkdir(path.dirname(savedDeep), { recursive: true });
      await fs.writeFile(savedDeep, "Original support");
      await fs.mkdir(path.dirname(currentDeep), { recursive: true });
      await fs.writeFile(
        currentDeep,
        deepContent === "edited" ? "Manual support" : "Original support",
      );
      if (deepContent === "file-deleted") {
        await fs.rm(currentDeep);
      } else if (deepContent === "subtree-deleted") {
        await fs.rm(path.dirname(currentDeep), { recursive: true });
      }
      const files = [
        file,
        path.join(savedSkill, "SKILL.md"),
        savedDeep,
        path.join(backupDir, "manifest.json"),
        ...(["unchanged", "edited"].includes(deepContent) ? [currentDeep] : []),
      ];
      const before = await Promise.all(files.map((entry) => fs.readFile(entry)));
      dispatchChange.mockClear();
      snapshotArtifact.mockClear();
      await expect(restore()).rejects.toThrow("Skill evaluation bundle exceeds traversal limits");
      expect(await Promise.all(files.map((entry) => fs.readFile(entry)))).toEqual(before);
      expect(dispatchChange).not.toHaveBeenCalled();
      expect(snapshotArtifact).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves recovery data when restore fails (rollback also fails: %s)",
    async (rollbackFails) => {
      const file = await writeSkill("procedure", "# Original\n");
      const backupDir = await seedBackup(() => writeSkill("procedure", "# Reviewed\n"));
      const copy = fs.cp.bind(fs);
      let failed = false;
      const copySpy = vi
        .spyOn(fs, "cp")
        .mockImplementation(async (source, destination, options) => {
          if (destination === path.dirname(file) && (!failed || rollbackFails)) {
            failed = true;
            throw new Error("restore copy failed");
          }
          await copy(source, destination, options);
        });
      const version = getSkillsSnapshotVersion();
      await expect(restore()).rejects.toThrow(
        rollbackFails ? "current collection was not restored" : "restore copy failed",
      );
      copySpy.mockRestore();
      expect(getSkillsSnapshotVersion()).toBeGreaterThan(version);
      if (rollbackFails) {
        const recovery = expectDefined(
          (await fs.readdir(backupDir)).find((entry) => entry.startsWith(".restore-")),
          "restore recovery",
        );
        await expect(
          fs.readFile(path.join(backupDir, recovery, "skills", "procedure", "SKILL.md"), "utf8"),
        ).resolves.toContain("# Reviewed");
      } else {
        await expect(fs.readFile(file, "utf8")).resolves.toContain("# Reviewed");
        await restore();
        await expect(fs.readFile(file, "utf8")).resolves.toContain("# Original");
      }
    },
  );
});
