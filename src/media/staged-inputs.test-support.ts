import fs from "node:fs/promises";
import path from "node:path";
import { ensureStagedInputDirectory, stagedInputDirectory } from "./staged-inputs.js";

/** Real producer markers beside project-owned lookalikes, including valid producer names. */
export async function createStagedInputOwnershipFixture(root: string) {
  const owned = ["c".repeat(64), "11111111-1111-4111-8111-111111111111"].map(stagedInputDirectory);
  for (const directory of owned) {
    await ensureStagedInputDirectory(root, directory);
  }
  const marker = await fs.readFile(path.join(root, owned[0]!, ".gitignore"));
  const unowned = [
    { identity: "cafe", marker: "exact" },
    { identity: "d".repeat(64), marker: "missing" },
    { identity: "22222222-2222-4222-8222-222222222222", marker: "missing" },
    { identity: "e".repeat(64), marker: "wrong" },
    { identity: "f".repeat(64), marker: "symlink" },
    { identity: "a1".repeat(32), marker: "hardlink" },
    { identity: "a2".repeat(32), marker: "directory" },
  ].map(({ identity, marker: kind }) => ({
    directory: stagedInputDirectory(identity),
    marker: kind,
  }));
  for (const { directory, marker: kind } of unowned) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
    const file = path.join(root, directory, ".gitignore");
    await fs.rm(file, { recursive: true, force: true });
    if (kind === "exact" || kind === "wrong") {
      await fs.writeFile(file, kind === "exact" ? marker : "*\n");
    } else if (kind === "directory") {
      await fs.mkdir(file);
    } else if (kind === "hardlink") {
      await fs.writeFile(`${file}-copy`, marker);
      await fs.link(`${file}-copy`, file);
    } else if (kind === "symlink") {
      await fs.symlink(
        path.relative(path.dirname(file), path.join(root, owned[0]!, ".gitignore")),
        file,
      );
    }
  }
  const files = (directories: string[]) =>
    directories.flatMap((directory) => [
      `${directory}/input-secret.txt`,
      `${directory}/input-cache.pyc`,
    ]);
  const ownedFiles = files(owned);
  const unownedFiles = files(unowned.map(({ directory }) => directory));
  for (const relative of [...ownedFiles, ...unownedFiles]) {
    await fs.writeFile(path.join(root, relative), `fixture bytes: ${relative}\n`);
  }
  return { ownedFiles, unownedFiles };
}
