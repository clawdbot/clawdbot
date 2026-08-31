import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  determineStatus,
  digestOpenClawSkillTree,
  hasLocalModifications,
  updateCommand,
} from "./check-update.mjs";

const fixtures = [];

after(async () => {
  await Promise.all(fixtures.map((directory) => rm(directory, { force: true, recursive: true })));
});

test("an auxiliary-file edit selects the forced update path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-validation-update-check-"));
  fixtures.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "SKILL.md"), "# Release validation\n");
  await writeFile(join(directory, "assets", "worksheet.md"), "original\n");

  const fileTreeSha256 = await digestOpenClawSkillTree(directory);
  const origin = { fileTreeSha256 };
  const lockEntry = { fileTreeSha256 };
  assert.equal(await hasLocalModifications(lockEntry, origin, directory), false);

  await writeFile(join(directory, "assets", "worksheet.md"), "locally edited\n");
  const modified = await hasLocalModifications(lockEntry, origin, directory);
  assert.equal(modified, true);
  assert.equal(determineStatus({ comparison: -1, modified }), "update-available");
  assert.equal(updateCommand({ force: modified }).at(-1), "--force");
});
