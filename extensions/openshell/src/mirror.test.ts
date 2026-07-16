import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("replaceDirectoryContents", () => {
  it("copies source entries to target", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();
    await fs.writeFile(path.join(source, "a.txt"), "hello");
    await fs.writeFile(path.join(target, "old.txt"), "stale");

    await replaceDirectoryContents({ sourceDir: source, targetDir: target });

    expect(await fs.readFile(path.join(target, "a.txt"), "utf8")).toBe("hello");
    await expect(fs.access(path.join(target, "old.txt"))).rejects.toThrow();
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
    await expect(fs.access(path.join(target, "existing.txt"))).rejects.toThrow();

    // hooks/ directory is preserved as-is — not replaced by attacker content
    expect(await fs.readFile(path.join(target, "hooks", "trusted", "handler.js"), "utf8")).toBe(
      "// trusted code",
    );
    await expect(fs.access(path.join(target, "hooks", "evil"))).rejects.toThrow();
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
    await expect(fs.access(path.join(target, "Hooks"))).rejects.toThrow();
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
    await expect(fs.access(path.join(target, ".git", "hooks", "post-checkout"))).rejects.toThrow();
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
    await expect(fs.lstat(path.join(target, "escaped-link"))).rejects.toThrow();
    await expect(fs.lstat(path.join(target, "nested", "escaped-dir"))).rejects.toThrow();
  });

  it("preserves existing trusted host symlinks", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    await fs.writeFile(path.join(source, "safe.txt"), "ok");
    await fs.writeFile(path.join(source, "linked-entry"), "remote-plain-file");
    await fs.symlink("/tmp/trusted-host-target", path.join(target, "linked-entry"));

    await replaceDirectoryContents({ sourceDir: source, targetDir: target });

    expect(await fs.readFile(path.join(target, "safe.txt"), "utf8")).toBe("ok");
    expect(await fs.readlink(path.join(target, "linked-entry"))).toBe("/tmp/trusted-host-target");
  });
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
    await expect(fs.lstat(path.join(staged, "escaped-link"))).rejects.toThrow();
    await expect(fs.lstat(path.join(staged, "nested", "escaped-dir"))).rejects.toThrow();
  });
});
