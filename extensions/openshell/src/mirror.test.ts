// Openshell tests cover mirror plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
  replaceDirectoryContents,
  stageDirectoryContents,
} from "./mirror.js";

const dirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mirror-test-"));
  dirs.push(dir);
  return dir;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let error: unknown;
  try {
    await fs.lstat(targetPath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("replaceDirectoryContents", () => {
  it("copies source entries to target", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();
    const outside = await makeTmpDir();
    await fs.writeFile(path.join(outside, "original.txt"), "host-only");
    await fs.link(path.join(outside, "original.txt"), path.join(target, "a.txt"));
    await fs.writeFile(path.join(source, "a.txt"), "hello");
    await fs.writeFile(path.join(target, "old.txt"), "stale");

    await replaceDirectoryContents({ sourceDir: source, targetDir: target });

    expect(await fs.readFile(path.join(target, "a.txt"), "utf8")).toBe("hello");
    expect(await fs.readFile(path.join(outside, "original.txt"), "utf8")).toBe("host-only");
    await expectPathMissing(path.join(target, "old.txt"));
  });

  it("applies remote deletions and file-directory replacements without protected links", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();
    await fs.mkdir(path.join(target, "deleted", "nested"), { recursive: true });
    await fs.writeFile(path.join(target, "deleted", "nested", "old.txt"), "stale");
    await fs.mkdir(path.join(target, "now-file"));
    await fs.writeFile(path.join(target, "now-file", "old.txt"), "stale");
    await fs.writeFile(path.join(source, "now-file"), "file");
    await fs.writeFile(path.join(target, "now-directory"), "stale");
    await fs.mkdir(path.join(source, "now-directory"));
    await fs.writeFile(path.join(source, "now-directory", "new.txt"), "directory");
    await fs.mkdir(path.join(source, "empty-directory"));

    await replaceDirectoryContents({ sourceDir: source, targetDir: target });

    await expectPathMissing(path.join(target, "deleted"));
    expect(await fs.readFile(path.join(target, "now-file"), "utf8")).toBe("file");
    expect(await fs.readFile(path.join(target, "now-directory", "new.txt"), "utf8")).toBe(
      "directory",
    );
    expect(await fs.readdir(path.join(target, "empty-directory"))).toEqual([]);
  });

  it("waits for in-flight copies before reporting a mirror failure", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested", "failed.txt"), "failed");
    await fs.writeFile(path.join(source, "nested", "delayed.txt"), "finished");
    const failure = new Error("copy failed");
    const failedCopyStarted = createDeferred<void>();
    const delayedCopyStarted = createDeferred<void>();
    const releaseCopy = createDeferred<void>();
    const originalCopyFile = fs.copyFile;
    const copyFile = vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      if (from === path.join(source, "nested", "failed.txt")) {
        failedCopyStarted.resolve();
        throw failure;
      }
      delayedCopyStarted.resolve();
      await releaseCopy.promise;
      await originalCopyFile(from, to, mode);
    });
    let settled = false;
    const replacement = replaceDirectoryContents({ sourceDir: source, targetDir: target }).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await Promise.all([failedCopyStarted.promise, delayedCopyStarted.promise]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      releaseCopy.resolve();
      expect(await replacement).toBe(failure);
      expect(await fs.readFile(path.join(target, "nested", "delayed.txt"), "utf8")).toBe(
        "finished",
      );
    } finally {
      releaseCopy.resolve();
      await replacement;
      copyFile.mockRestore();
    }
  });

  // Mirrored OpenShell sandbox content must never overwrite trusted workspace
  // hook directories.
  it("excludes specified directories from sync", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    // Source has a hooks/ dir with an attacker-controlled handler
    await fs.mkdir(path.join(source, "hooks", "evil"), { recursive: true });
    await fs.writeFile(
      path.join(source, "hooks", "evil", "handler.js"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/pwned", "pwned");\nexport default async function handler() {}',
    );
    await fs.writeFile(path.join(source, "code.txt"), "legit");

    // Target has existing trusted hooks
    await fs.mkdir(path.join(target, "hooks", "trusted"), { recursive: true });
    await fs.writeFile(path.join(target, "hooks", "trusted", "handler.js"), "// trusted code");
    await fs.writeFile(path.join(target, "existing.txt"), "old");

    await replaceDirectoryContents({
      sourceDir: source,
      targetDir: target,
      excludeDirs: ["hooks"],
    });

    // Legitimate content is synced
    expect(await fs.readFile(path.join(target, "code.txt"), "utf8")).toBe("legit");

    // Old non-excluded content is removed
    await expectPathMissing(path.join(target, "existing.txt"));

    // hooks/ directory is preserved as-is — not replaced by attacker content
    expect(await fs.readFile(path.join(target, "hooks", "trusted", "handler.js"), "utf8")).toBe(
      "// trusted code",
    );
    await expectPathMissing(path.join(target, "hooks", "evil"));
  });

  it("excludeDirs matching is case-insensitive", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    // Source uses variant casing to try to bypass the exclusion
    await fs.mkdir(path.join(source, "Hooks", "evil"), { recursive: true });
    await fs.writeFile(path.join(source, "Hooks", "evil", "handler.js"), "// malicious");
    await fs.writeFile(path.join(source, "data.txt"), "ok");

    await replaceDirectoryContents({
      sourceDir: source,
      targetDir: target,
      excludeDirs: ["hooks"],
    });

    // Legitimate content is synced
    expect(await fs.readFile(path.join(target, "data.txt"), "utf8")).toBe("ok");

    // "Hooks" (variant case) must still be excluded
    await expectPathMissing(path.join(target, "Hooks"));
  });

  it("preserves default excluded directories and repository metadata", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    await fs.mkdir(path.join(source, "hooks"), { recursive: true });
    await fs.writeFile(path.join(source, "hooks", "pre-commit"), "malicious");
    await fs.mkdir(path.join(source, "git-hooks"), { recursive: true });
    await fs.writeFile(path.join(source, "git-hooks", "pre-commit"), "malicious");
    await fs.mkdir(path.join(source, ".git", "hooks"), { recursive: true });
    await fs.writeFile(path.join(source, ".git", "hooks", "post-checkout"), "malicious");
    await fs.writeFile(path.join(source, "safe.txt"), "ok");

    await fs.mkdir(path.join(target, "hooks"), { recursive: true });
    await fs.writeFile(path.join(target, "hooks", "trusted"), "trusted");
    await fs.mkdir(path.join(target, "git-hooks"), { recursive: true });
    await fs.writeFile(path.join(target, "git-hooks", "trusted"), "trusted");
    await fs.mkdir(path.join(target, ".git"), { recursive: true });
    await fs.writeFile(path.join(target, ".git", "HEAD"), "ref: refs/heads/main\n");

    await replaceDirectoryContents({
      sourceDir: source,
      targetDir: target,
      excludeDirs: DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
    });

    expect(await fs.readFile(path.join(target, "safe.txt"), "utf8")).toBe("ok");
    expect(await fs.readFile(path.join(target, "hooks", "trusted"), "utf8")).toBe("trusted");
    expect(await fs.readFile(path.join(target, "git-hooks", "trusted"), "utf8")).toBe("trusted");
    expect(await fs.readFile(path.join(target, ".git", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/main\n",
    );
    await expectPathMissing(path.join(target, ".git", "hooks", "post-checkout"));
  });

  it("skips symbolic links when copying into the host workspace", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    await fs.writeFile(path.join(source, "safe.txt"), "ok");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.writeFile(path.join(source, "nested", "file.txt"), "nested");
    await fs.symlink("/tmp/host-secret", path.join(source, "escaped-link"));
    await fs.symlink("/tmp/host-secret-dir", path.join(source, "nested", "escaped-dir"));

    await replaceDirectoryContents({ sourceDir: source, targetDir: target });

    expect(await fs.readFile(path.join(target, "safe.txt"), "utf8")).toBe("ok");
    expect(await fs.readFile(path.join(target, "nested", "file.txt"), "utf8")).toBe("nested");
    await expectPathMissing(path.join(target, "escaped-link"));
    await expectPathMissing(path.join(target, "nested", "escaped-dir"));
  });

  it.each(["directory", "absent", "file", "symlink"] as const)(
    "preserves trusted host symlinks when their remote ancestor is %s",
    async (remoteAncestor) => {
      const source = await makeTmpDir();
      const target = await makeTmpDir();
      const outside = await makeTmpDir();
      await fs.writeFile(path.join(outside, "canary.txt"), "host-only");
      const linkTargets = {
        "file-link": path.join(outside, "canary.txt"),
        "directory-link": outside,
        "dangling-link": "missing-relative-target",
      };
      const nested = path.join(target, "nested", "deeper");
      await fs.mkdir(nested, { recursive: true });
      for (const [name, destination] of Object.entries(linkTargets)) {
        await fs.symlink(destination, path.join(nested, name));
      }
      await fs.writeFile(path.join(nested, "deleted.txt"), "stale");
      await fs.symlink(outside, path.join(target, "linked-entry"));
      await stageDirectoryContents({ sourceDir: target, targetDir: source });

      await fs.writeFile(path.join(source, "safe.txt"), "ok");
      await fs.writeFile(path.join(source, "linked-entry"), "remote-plain-file");
      await fs.rm(path.join(source, "nested"), { recursive: true });
      if (remoteAncestor === "directory") {
        await fs.mkdir(path.join(source, "nested", "deeper"), { recursive: true });
        await fs.writeFile(path.join(source, "nested", "deeper", "file-link"), "remote");
        await fs.mkdir(path.join(source, "nested", "deeper", "directory-link"));
        await fs.writeFile(
          path.join(source, "nested", "deeper", "directory-link", "new.txt"),
          "remote",
        );
        await fs.symlink(outside, path.join(source, "nested", "deeper", "dangling-link"));
      } else if (remoteAncestor === "file") {
        await fs.writeFile(path.join(source, "nested"), "remote replacement");
      } else if (remoteAncestor === "symlink") {
        await fs.symlink(outside, path.join(source, "nested"));
      }

      await replaceDirectoryContents({ sourceDir: source, targetDir: target });

      expect(await fs.readFile(path.join(target, "safe.txt"), "utf8")).toBe("ok");
      expect(await fs.readlink(path.join(target, "linked-entry"))).toBe(outside);
      for (const [name, destination] of Object.entries(linkTargets)) {
        expect(await fs.readlink(path.join(nested, name))).toBe(destination);
      }
      await expectPathMissing(path.join(nested, "deleted.txt"));
      expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("host-only");
      expect(await fs.readdir(outside)).toEqual(["canary.txt"]);
    },
  );
});

describe("stageDirectoryContents", () => {
  it("stages upload content without symbolic links", async () => {
    const source = await makeTmpDir();
    const staged = await makeTmpDir();

    await fs.writeFile(path.join(source, "safe.txt"), "ok");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.writeFile(path.join(source, "nested", "file.txt"), "nested");
    await fs.symlink("/tmp/host-secret", path.join(source, "escaped-link"));
    await fs.symlink("/tmp/host-secret-dir", path.join(source, "nested", "escaped-dir"));

    await stageDirectoryContents({ sourceDir: source, targetDir: staged });

    expect(await fs.readFile(path.join(staged, "safe.txt"), "utf8")).toBe("ok");
    expect(await fs.readFile(path.join(staged, "nested", "file.txt"), "utf8")).toBe("nested");
    await expectPathMissing(path.join(staged, "escaped-link"));
    await expectPathMissing(path.join(staged, "nested", "escaped-dir"));
  });
});
