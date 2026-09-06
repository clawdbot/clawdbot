import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import {
  prepareWorkerProjectSnapshot,
  prepareWorkerWorkspaceGitPack,
} from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createRepository(root: string, format = "sha1") {
  await fs.mkdir(root);
  await requireGit(root, ["init", "--quiet", `--object-format=${format}`]);
  await requireGit(root, ["config", "user.name", "Project Test"]);
  await requireGit(root, ["config", "user.email", "project@example.invalid"]);
  await fs.writeFile(path.join(root, "input.txt"), "committed input\n");
  await requireGit(root, ["add", "."]);
  await requireGit(root, ["commit", "--quiet", "-m", "base"]);
}

describe("prepared worker projects", () => {
  it("shares a project across linked worktrees and commits while isolating repositories and gateways", async () => {
    const root = await fs.realpath(tempDirs.make("worker-project-identity-"));
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "linked");
    await createRepository(repository);
    await requireGit(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
    const prepare = (localPath: string, namespace = "gateway-one") =>
      prepareWorkerProjectSnapshot({ localPath, namespace });
    const original = await prepare(repository);
    expect(original).toBeDefined();
    expect(await prepare(worktree)).toEqual({ ...original, root: worktree });

    await fs.writeFile(path.join(worktree, "input.txt"), "next commit\n");
    await requireGit(worktree, ["commit", "--quiet", "-am", "next"]);
    const updated = await prepare(worktree);
    expect(updated?.key).toBe(original?.key);
    expect(updated?.baseCommit).not.toBe(original?.baseCommit);
    expect(updated?.baseCommit).toBe(await requireGit(worktree, ["rev-parse", "HEAD"]));
    expect(
      await prepareWorkerProjectSnapshot({
        localPath: worktree,
        namespace: "gateway-one",
        baseCommit: original!.baseCommit,
      }),
    ).toEqual({ ...original, root: worktree });
    await expect(
      prepareWorkerProjectSnapshot({
        localPath: worktree,
        namespace: "gateway-one",
        baseCommit: "f".repeat(40),
      }),
    ).rejects.toThrow();
    expect((await prepare(worktree, "gateway-two"))?.key).not.toBe(original?.key);

    const unrelated = path.join(root, "unrelated");
    await createRepository(unrelated);
    expect((await prepare(unrelated))?.key).not.toBe(original?.key);
  });

  it("does not invent a project snapshot for a plain or unborn workspace", async () => {
    const root = await fs.realpath(tempDirs.make("worker-project-unborn-"));
    const prepare = () => prepareWorkerProjectSnapshot({ localPath: root, namespace: "gateway" });
    expect(await prepare()).toBeUndefined();
    await requireGit(root, ["init", "--quiet"]);
    await fs.writeFile(path.join(root, "input.txt"), "uncommitted\n");
    await requireGit(root, ["add", "."]);
    expect(await prepare()).toBeUndefined();
  });

  it.each(["sha1", "sha256"])(
    "transfers A to B to A against a standalone shallow %s base",
    async (format) => {
      const root = await fs.realpath(tempDirs.make("worker-project-delta-"));
      const repository = path.join(root, "repository");
      await createRepository(repository, format);
      const ancestor = await requireGit(repository, ["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(repository, "input.txt"), "snapshot A\n");
      await fs.writeFile(path.join(repository, "bulk.bin"), randomBytes(1024 * 1024));
      await requireGit(repository, ["add", "."]);
      await requireGit(repository, ["commit", "--quiet", "-m", "A"]);
      const a = await requireGit(repository, ["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(repository, "input.txt"), "snapshot B\n");
      await requireGit(repository, ["commit", "--quiet", "-am", "B"]);
      const b = await requireGit(repository, ["rev-parse", "HEAD"]);
      const receiver = path.join(root, "receiver");
      await fs.mkdir(receiver);
      await requireGit(receiver, ["init", "--quiet", `--object-format=${format}`]);
      await fs.writeFile(path.join(receiver, ".git", "shallow"), `${a}\n${b}\n`);
      const sizes = [];
      for (const [index, [baseCommit, retainedCommit]] of [
        [a, undefined],
        [b, a],
        [a, b],
      ].entries()) {
        const temporaryRoot = path.join(root, `pack-${index}`);
        await fs.mkdir(temporaryRoot);
        const pack = await prepareWorkerWorkspaceGitPack({
          root: repository,
          baseCommit: baseCommit!,
          retainedCommit,
          temporaryRoot,
          signal: new AbortController().signal,
        });
        sizes.push((await fs.stat(pack)).size);
        await requireGit(receiver, ["index-pack", "--stdin", "--fix-thin"], {
          input: await fs.readFile(pack),
        });
        await requireGit(receiver, ["fsck", "--full", "--strict", "--no-reflogs", baseCommit!]);
        await requireGit(receiver, ["checkout", "--quiet", "--detach", baseCommit!]);
        expect(await requireGit(receiver, ["write-tree"])).toBe(
          await requireGit(repository, ["rev-parse", `${baseCommit}^{tree}`]),
        );
        expect(await fs.readFile(path.join(receiver, "input.txt"), "utf8")).toBe(
          baseCommit === a ? "snapshot A\n" : "snapshot B\n",
        );
      }
      expect(sizes[1]).toBeLessThan(sizes[0]! / 100);
      expect(sizes[2]).toBeLessThan(sizes[0]! / 100);
      await fs.rename(repository, `${repository}-offline`);
      expect((await runGit(receiver, ["cat-file", "-e", ancestor])).code).not.toBe(0);
      await requireGit(receiver, ["fsck", "--full", "--strict", "--no-reflogs", a, b]);
      expect(
        await fs
          .stat(path.join(receiver, ".git", "objects", "info", "alternates"))
          .catch(() => undefined),
      ).toBeUndefined();
    },
  );

  it("packs only the pinned commit and tree without local credentials, overlays, or history", async () => {
    const root = await fs.realpath(tempDirs.make("worker-project-pack-"));
    const repository = path.join(root, "repository");
    await createRepository(repository);
    const ancestor = await requireGit(repository, ["rev-parse", "HEAD"]);
    const oldBlob = await requireGit(repository, ["rev-parse", "HEAD:input.txt"]);
    await fs.writeFile(path.join(repository, "input.txt"), "prepared project\n");
    await requireGit(repository, ["commit", "--quiet", "-am", "prepared"]);
    await requireGit(repository, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/private/repository.git",
    ]);
    const project = await prepareWorkerProjectSnapshot({
      localPath: repository,
      namespace: "gateway",
    });
    expect(project).toBeDefined();
    await fs.writeFile(path.join(repository, "input.txt"), "later commit\n");
    await requireGit(repository, ["commit", "--quiet", "-am", "later"]);
    const later = await requireGit(repository, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repository, "input.txt"), "dirty session input\n");
    await fs.writeFile(path.join(repository, "private.txt"), "untracked session file\n");
    const pack = await prepareWorkerWorkspaceGitPack({
      root: project!.root,
      baseCommit: project!.baseCommit,
      temporaryRoot: root,
      signal: new AbortController().signal,
    });
    const unpacked = path.join(root, "unpacked");
    await fs.mkdir(unpacked);
    await requireGit(unpacked, ["init", "--quiet"]);
    await requireGit(unpacked, ["index-pack", "--stdin"], { input: await fs.readFile(pack) });
    expect(await requireGit(unpacked, ["show", `${project!.baseCommit}:input.txt`])).toBe(
      "prepared project",
    );
    expect(await requireGit(unpacked, ["ls-tree", "--name-only", project!.baseCommit])).toBe(
      "input.txt",
    );
    for (const absent of [ancestor, oldBlob, later]) {
      expect((await runGit(unpacked, ["cat-file", "-e", absent])).code).not.toBe(0);
    }
    expect((await runGit(unpacked, ["remote", "get-url", "origin"])).code).not.toBe(0);
    expect(await fs.readFile(path.join(repository, "input.txt"), "utf8")).toBe(
      "dirty session input\n",
    );
  });
});
