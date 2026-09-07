import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyNodeRepositoryCheckpoint } from "../node-host/node-worker-repository-transfers.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import { prepareRepositoryPublicationRestore } from "./github-repository-publication-restore.js";
import {
  REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
  readGitHubRepositoryPublicationBlob,
  readGitHubRepositoryPublicationMetadata,
} from "./github-repository-publication-snapshot.js";
import { readActualWorkspaceManifest } from "./worker-environments/workspace-reconcile-core.js";

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

async function fixture(linked: false | "linked" | "linked-config" = false) {
  const root = temporary.make("github-repository-snapshot-");
  let cwd = path.join(root, "worker");
  await fs.mkdir(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git("init", "--quiet");
  await fs.writeFile(path.join(cwd, ".gitattributes"), "*.txt text eol=lf\n");
  await fs.writeFile(path.join(cwd, ".gitignore"), "ignored*.txt\n");
  await fs.writeFile(path.join(cwd, "ignored-removed.txt"), "private generated fixture\n");
  git("add", "-f", "ignored-removed.txt");
  await fs.writeFile(path.join(cwd, "counter.txt"), "zero\n");
  await fs.writeFile(path.join(cwd, "removed.txt"), "remove me\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  if (linked) {
    if (linked === "linked-config") {
      git("config", "extensions.worktreeConfig", "true");
    }
    const checkout = path.join(root, "linked");
    git("worktree", "add", "--quiet", "--detach", checkout, base);
    cwd = checkout;
  }
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

  it.each(["full", "split", "linked", "linked-config"] as const)(
    "preserves staged path inventory and index bytes while normalizing the full worktree (%s index)",
    async (format) => {
      const f = await fixture(format === "linked" || format === "linked-config" ? format : false);
      await fs.writeFile(path.join(f.cwd, "ignored-added.txt"), "staged\r\n");
      f.git("add", "-f", "ignored-added.txt");
      await fs.writeFile(path.join(f.cwd, "ignored-intent.txt"), "intent\r\n");
      f.git("add", "-N", "-f", "ignored-intent.txt");
      f.git("rm", "--cached", "ignored-removed.txt");
      await fs.writeFile(path.join(f.cwd, "counter.txt"), "staged counter\r\n");
      f.git("add", "counter.txt");
      await fs.writeFile(path.join(f.cwd, "counter.txt"), "latest counter\r\n");
      await fs.writeFile(path.join(f.cwd, "ignored-added.txt"), "latest\r\n");
      if (format === "split") {
        f.git("update-index", "--split-index");
      }
      const indexPath = path.resolve(f.cwd, f.git("rev-parse", "--git-path", "index"));
      const index = await fs.readFile(indexPath);
      const digest = f.capture();
      const { snapshot } = await readGitHubRepositoryPublicationMetadata(f.output, digest);
      expect(await fs.readFile(indexPath)).toEqual(index);
      expect(snapshot.entries).toEqual(
        expect.arrayContaining([
          { path: "ignored-removed.txt", mode: "100644", sha: null },
          expect.objectContaining({ path: "ignored-added.txt", mode: "100644" }),
          expect.objectContaining({ path: "ignored-intent.txt", mode: "100644" }),
        ]),
      );
      const local = await captureGitHubPublicationWorkspaceSnapshot({ cwd: f.cwd });
      expect(await fs.readFile(indexPath)).toEqual(index);
      expect(local.workspaceTree).toBe(snapshot.workspaceTree);
      expect(f.git("show", `${local.sourceIndexTree}:ignored-added.txt`)).toBe("staged");
      for (const [name, content] of [
        ["ignored-added.txt", "latest\n"],
        ["ignored-intent.txt", "intent\n"],
        ["counter.txt", "latest counter\n"],
      ] as const) {
        const entry = snapshot.entries.find((candidate) => candidate.path === name)!;
        expect(await readGitHubRepositoryPublicationBlob(f.output, entry.sha!)).toEqual(
          Buffer.from(content),
        );
      }
      expect(await fs.readFile(path.join(f.cwd, "ignored-removed.txt"), "utf8")).toBe(
        "private generated fixture\n",
      );
    },
  );

  it("restores accepted publication paths as unstaged without running hooks or filters", async () => {
    const f = await fixture();
    const base = await readActualWorkspaceManifest({ root: f.cwd, baseCommit: f.base });
    await fs.writeFile(path.join(f.cwd, "ignored-[1].txt"), "publishable\n");
    await fs.writeFile(path.join(f.cwd, "ignored-private.txt"), "recovery only\n");
    await fs.writeFile(path.join(f.cwd, ".worktreeinclude"), "ignored-private.txt\n");
    f.git("--literal-pathspecs", "add", "-f", "--", "ignored-[1].txt");
    if (process.platform !== "win32") {
      await fs.symlink("counter.txt", path.join(f.cwd, "ignored-link.txt"));
      f.git("add", "-f", "ignored-link.txt");
    }
    const current = await readActualWorkspaceManifest({ root: f.cwd, baseCommit: f.base });
    const digest = f.capture();
    const restored = path.join(f.root, "restored");
    f.git("clone", "--quiet", "--no-local", "--", f.cwd, restored);
    await applyNodeRepositoryCheckpoint({
      workspaceDir: restored,
      stagingRoot: f.cwd,
      baseManifestRef: base.manifestRef,
      currentManifestRef: current.manifestRef,
      base: base.manifest,
      current: current.manifest,
    });
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          restored,
          "-c",
          `core.hooksPath=${os.devNull}`,
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        { env, encoding: "utf8" },
      ).trim();
    const hooks = path.join(restored, ".git", "test-hooks");
    const sentinel = path.join(f.root, "unexpected-hook-or-filter");
    await fs.mkdir(hooks);
    await fs.writeFile(
      path.join(hooks, "post-index-change"),
      `#!/bin/sh\nprintf hook > '${sentinel}'\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(restored, ".git", "info", "attributes"),
      "ignored*.txt filter=synthetic\n",
    );
    git("config", "core.hooksPath", hooks);
    git("config", "core.fsmonitor", `printf fsmonitor > '${sentinel}'`);
    git("config", "filter.synthetic.clean", `printf filter > '${sentinel}'`);
    expect(await fs.readFile(sentinel, "utf8").catch(() => undefined)).toBeUndefined();
    const commands = await prepareRepositoryPublicationRestore({
      current: current.manifest,
      publicationStagingRoot: f.output,
      publicationDigest: digest,
    });
    const restore = () => {
      for (const command of commands) {
        execFileSync(process.execPath, command.argv.slice(1), {
          cwd: restored,
          env,
          input: command.input,
          stdio: "pipe",
        });
      }
    };
    expect(restore).toThrow();
    expect(await fs.readFile(sentinel, "utf8").catch(() => undefined)).toBeUndefined();
    git("config", "--unset", "core.fsmonitor");
    expect(restore).toThrow();
    expect(await fs.readFile(sentinel, "utf8").catch(() => undefined)).toBeUndefined();
    git("config", "--unset", "filter.synthetic.clean");
    restore();
    expect(await fs.readFile(sentinel, "utf8").catch(() => undefined)).toBeUndefined();
    expect(git("--literal-pathspecs", "ls-files", "--", "ignored-[1].txt")).toBe("ignored-[1].txt");
    expect(git("ls-files", "--", "ignored-private.txt")).toBe("");
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(await fs.readFile(path.join(restored, "ignored-[1].txt"), "utf8")).toBe("publishable\n");
    expect(await fs.readFile(path.join(restored, "ignored-private.txt"), "utf8")).toBe(
      "recovery only\n",
    );
    if (process.platform !== "win32") {
      expect(await fs.readlink(path.join(restored, "ignored-link.txt"))).toBe("counter.txt");
      expect(git("ls-files", "--", "ignored-link.txt")).toBe("ignored-link.txt");
    }
  });

  it("rejects an unresolved index without changing conflict stages or working files", async () => {
    const f = await fixture();
    f.git("switch", "--quiet", "-c", "conflicting");
    await fs.writeFile(path.join(f.cwd, "counter.txt"), "one\n");
    f.git("commit", "--quiet", "-am", "one");
    f.git("switch", "--quiet", "--detach", f.base);
    await fs.writeFile(path.join(f.cwd, "counter.txt"), "two\n");
    f.git("commit", "--quiet", "-am", "two");
    expect(() => f.git("merge", "conflicting")).toThrow();
    const indexPath = path.resolve(f.cwd, f.git("rev-parse", "--git-path", "index"));
    const index = await fs.readFile(indexPath);
    const conflict = await fs.readFile(path.join(f.cwd, "counter.txt"));
    expect(f.capture).toThrow();
    await expect(captureGitHubPublicationWorkspaceSnapshot({ cwd: f.cwd })).rejects.toThrow();
    expect(await fs.readFile(indexPath)).toEqual(index);
    expect(await fs.readFile(path.join(f.cwd, "counter.txt"))).toEqual(conflict);
  });

  it.each(["--local", "--worktree"] as const)(
    "rejects a configured clean command in %s before the snapshot can run it",
    async (scope) => {
      const f = await fixture();
      await fs.writeFile(path.join(f.cwd, ".gitattributes"), "*.txt filter=synthetic\n");
      if (scope === "--worktree") {
        f.git("config", "extensions.worktreeConfig", "true");
      }
      f.git("config", scope, "filter.synthetic.clean", "touch ran-clean-filter");
      expect(f.capture).toThrow();
      await expect(fs.stat(path.join(f.cwd, "ran-clean-filter"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

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
