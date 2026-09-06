import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { loadSkillRootRecords } from "../loading/skill-root-loader.js";
import { proposeUpdateSkill } from "./service.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import {
  listWritableWorkshopSkillSummaries,
  readWritableWorkshopSkill,
} from "./workspace-skill-read.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workshop-skill-read-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

async function writeSkill(dir: string, name: string, body = ""): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} procedure\n---\n\n# ${name}\n${body}`,
    "utf8",
  );
}

describe("listWritableWorkshopSkillSummaries", () => {
  it("ignores a SKILL.md placed directly in the Workshop root", async () => {
    const workshopDir = resolveWorkshopSkillsDir({}, "main", testState.env);
    await fs.mkdir(workshopDir, { recursive: true });
    await fs.writeFile(path.join(workshopDir, "SKILL.md"), "# Root skill\n");
    await writeSkill(path.join(workshopDir, "real"), "real");

    expect(
      listWritableWorkshopSkillSummaries({ config: {}, agentId: "main", env: testState.env }).map(
        (skill) => skill.name,
      ),
    ).toEqual(["real"]);
    expect(
      loadSkillRootRecords({ dir: workshopDir, source: "openclaw-workshop" }).map(
        ({ skill }) => skill.name,
      ),
    ).toEqual(["real"]);
  });

  it("uses the declared name for grouped skills when reading and updating", async () => {
    const baseDir = path.join(
      resolveWorkshopSkillsDir({}, "main", testState.env),
      "group",
      "folder-name",
    );
    await writeSkill(baseDir, "declared-name");

    expect(
      listWritableWorkshopSkillSummaries({ config: {}, agentId: "main", env: testState.env }),
    ).toEqual([expect.objectContaining({ name: "declared-name", baseDir })]);
    await expect(
      readWritableWorkshopSkill("declared-name", {
        config: {},
        agentId: "main",
        env: testState.env,
      }),
    ).resolves.toMatchObject({
      skillKey: "declared-name",
      baseDir,
    });
    await expect(
      proposeUpdateSkill({
        workspaceDir: await tempDirs.make("openclaw-workshop-declared-name-workspace-"),
        agentId: "main",
        config: {},
        env: testState.env,
        skillName: "declared-name",
        content: "# Updated\n",
      }),
    ).resolves.toMatchObject({
      record: {
        target: {
          skillKey: "declared-name",
          skillDir: baseDir,
          skillFile: path.join(baseDir, "SKILL.md"),
        },
      },
    });
  });

  it("applies the configured per-source count and file-size limits", async () => {
    const workshopDir = resolveWorkshopSkillsDir({}, "main", testState.env);
    for (const name of ["alpha", "beta", "gamma"]) {
      await writeSkill(path.join(workshopDir, name), name);
    }
    await writeSkill(path.join(workshopDir, "delta"), "delta", "x".repeat(2_000));

    const names = (
      config?: Omit<
        Parameters<typeof listWritableWorkshopSkillSummaries>[0],
        "config" | "agentId" | "env"
      > & {
        config?: Parameters<typeof listWritableWorkshopSkillSummaries>[0]["config"];
      },
    ) =>
      listWritableWorkshopSkillSummaries({
        config: {},
        agentId: "main",
        ...config,
        env: testState.env,
      }).map((skill) => skill.name);
    expect(names({})).toEqual(["alpha", "beta", "delta", "gamma"]);
    expect(names({ config: { skills: { limits: { maxSkillsLoadedPerSource: 2 } } } })).toEqual([
      "alpha",
      "beta",
    ]);
    const sizeLimited = { config: { skills: { limits: { maxSkillFileBytes: 1_000 } } } };
    expect(names(sizeLimited)).toEqual(["alpha", "beta", "gamma"]);
    await expect(
      readWritableWorkshopSkill("delta", {
        agentId: "main",
        ...sizeLimited,
        env: testState.env,
      }),
    ).rejects.toThrow(/No Workshop-generated skill matched: delta/);
  });

  it("ignores a symlinked skill directory that leaves the Workshop root", async () => {
    const workshopDir = resolveWorkshopSkillsDir({}, "main", testState.env);
    await writeSkill(path.join(workshopDir, "inside"), "inside");
    const outsideDir = path.join(await tempDirs.make("openclaw-workshop-outside-"), "outside");
    await writeSkill(outsideDir, "outside");
    await fs.symlink(outsideDir, path.join(workshopDir, "outside"), "dir");

    expect(
      listWritableWorkshopSkillSummaries({ config: {}, agentId: "main", env: testState.env }).map(
        (skill) => skill.name,
      ),
    ).toEqual(["inside"]);
  });
});
