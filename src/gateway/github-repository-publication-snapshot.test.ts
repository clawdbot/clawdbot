import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
  readGitHubRepositoryPublicationBlob,
  readGitHubRepositoryPublicationMetadata,
} from "./github-repository-publication-snapshot.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_AUTHOR_NAME: "Snapshot Fixture",
  GIT_AUTHOR_EMAIL: "snapshot@example.test",
  GIT_COMMITTER_NAME: "Snapshot Fixture",
  GIT_COMMITTER_EMAIL: "snapshot@example.test",
};

async function fixture() {
  const root = temporary.make("github-repository-snapshot-");
  const cwd = path.join(root, "worker");
  await fs.mkdir(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git("init", "--quiet");
  await fs.writeFile(path.join(cwd, ".gitattributes"), "*.txt text eol=lf\n");
  await fs.writeFile(path.join(cwd, "counter.txt"), "zero\n");
  await fs.writeFile(path.join(cwd, "removed.txt"), "remove me\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const output = path.join(root, "snapshot");
  const capture = () =>
    execFileSync(
      process.execPath,
      ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, cwd, base, output],
      { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  return { cwd, root, git, base, output, capture };
}

describe("repository publication checkpoint capture", () => {
  it("captures a cumulative Git-normalized sparse tree, binary bytes, modes and deletions without changing the worker index", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "counter.txt"), "first\r\n");
    f.git("add", "counter.txt");
    f.git("commit", "--quiet", "-m", "worker turn one");
    await fs.writeFile(path.join(f.cwd, "later.txt"), "second\r\n");
    await fs.writeFile(path.join(f.cwd, "binary.dat"), Buffer.from([0, 255, 128, 13, 10]));
    await fs.writeFile(path.join(f.cwd, "run.sh"), "#!/bin/sh\ntrue\n", { mode: 0o755 });
    await fs.rm(path.join(f.cwd, "removed.txt"));
    if (process.platform !== "win32") {
      await fs.symlink("counter.txt", path.join(f.cwd, "counter-link"));
    }
    const index = f.git("write-tree");
    const head = f.git("rev-parse", "HEAD");
    const digest = f.capture();
    const { snapshot } = await readGitHubRepositoryPublicationMetadata(f.output, digest);
    expect(snapshot.baseCommit).toBe(f.base);
    expect(snapshot.entries.map((entry) => entry.path)).not.toContain(".gitattributes");
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        { path: "removed.txt", mode: "100644", sha: null },
        expect.objectContaining({
          path: "run.sh",
          mode: process.platform === "win32" ? "100644" : "100755",
        }),
      ]),
    );
    for (const [name, bytes] of [
      ["counter.txt", Buffer.from("first\n")],
      ["later.txt", Buffer.from("second\n")],
      ["binary.dat", Buffer.from([0, 255, 128, 13, 10])],
      ...(process.platform === "win32" ? [] : [["counter-link", Buffer.from("counter.txt")]]),
    ] as Array<[string, Buffer]>) {
      const entry = snapshot.entries.find((candidate) => candidate.path === name)!;
      expect(await readGitHubRepositoryPublicationBlob(f.output, entry.sha!)).toEqual(bytes);
    }
    expect(f.git("write-tree")).toBe(index);
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    expect(await fs.readFile(path.join(f.cwd, "later.txt"), "utf8")).toBe("second\r\n");
    const stored = await fs.readdir(path.join(f.output, "blobs"));
    expect(stored).toHaveLength(snapshot.entries.filter((entry) => entry.sha).length);
  });

  it("rejects a configured clean command before the snapshot can run it", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, ".gitattributes"), "*.txt filter=synthetic\n");
    f.git("config", "--local", "filter.synthetic.clean", "touch ran-clean-filter");
    expect(f.capture).toThrow();
    await expect(fs.stat(path.join(f.cwd, "ran-clean-filter"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects substituted checkpoint bytes and paths outside the normalized payload", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "counter.txt"), "changed\n");
    const digest = f.capture();
    const { snapshot } = await readGitHubRepositoryPublicationMetadata(f.output, digest);
    const entry = snapshot.entries[0]!;
    await fs.writeFile(path.join(f.output, "blobs", entry.sha!), "different\n");
    await expect(readGitHubRepositoryPublicationBlob(f.output, entry.sha!)).rejects.toThrow(
      "changed",
    );
    const unsafe = JSON.stringify({ ...snapshot, entries: [{ ...entry, path: "../escape" }] });
    await fs.writeFile(path.join(f.output, "snapshot.json"), unsafe);
    await expect(readGitHubRepositoryPublicationMetadata(f.output, digest)).rejects.toThrow(
      "digest",
    );
    await expect(
      readGitHubRepositoryPublicationMetadata(
        f.output,
        "sha256:" + createHash("sha256").update(unsafe).digest("hex"),
      ),
    ).rejects.toThrow("entry");
    if (process.platform !== "win32") {
      await fs.rm(path.join(f.output, "blobs", entry.sha!));
      await fs.symlink(path.join(f.cwd, "counter.txt"), path.join(f.output, "blobs", entry.sha!));
      await expect(readGitHubRepositoryPublicationBlob(f.output, entry.sha!)).rejects.toThrow();
    }
  });
});
