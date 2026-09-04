import { renameSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  prepareSkillBundle,
  prepareSkillLibraryBundle,
  readSkillBundleTree,
  readSkillLibraryTree,
} from "./bundle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const markdown = {
  path: "SKILL.md",
  content: "---\nname: demo\ndescription: Test procedure\n---\n# Demo\n",
};
const resource = { path: "scripts/test.sh", content: "#!/bin/sh\nprintf hello", executable: true };

describe("portable complete skill revision identity", () => {
  it("hashes file paths, exact bytes, and executability independently of enumeration order", () => {
    const original = prepareSkillLibraryBundle([markdown, resource]);
    expect(original.revision).toBe(
      "c4999fd620e1fbeaf3c097816e7c3d174e5fb9722b165527b92f18f81af350d4",
    );
    expect(prepareSkillBundle([markdown, resource]).revision).toBe(original.revision);
    expect(prepareSkillLibraryBundle([resource, markdown]).revision).toBe(original.revision);
    for (const changed of [
      { ...resource, path: "scripts/renamed.sh" },
      { ...resource, content: `${resource.content}\n` },
      { ...resource, executable: false },
    ]) {
      expect(prepareSkillLibraryBundle([markdown, changed]).revision).not.toBe(original.revision);
    }
  });
  it.each(["---\ndescription: Test procedure\n---\n# Demo\n", "---\nname: demo\n---\n# Demo\n"])(
    "keeps publication metadata required for managed skills: %s",
    (content) => {
      expect(() => prepareSkillLibraryBundle([{ path: "SKILL.md", content }])).toThrow(
        "requires name and description",
      );
    },
  );
  it.each([
    "../escape",
    "/absolute",
    "a\\b",
    "C:/a",
    "a//b",
    "a/./b",
    "CON.txt",
    "CONIN$",
    "conout$",
    "COM¹.txt",
    "LPT³",
    "file.",
    "a/../b",
    "node_modules/a",
    "bad-\ud800-name",
  ])("rejects non-portable %s", (badPath) => {
    expect(() => prepareSkillLibraryBundle([markdown, { path: badPath, content: "x" }])).toThrow(
      "Non-portable",
    );
  });
  it("rejects case collisions, file/directory collisions, and oversized files", () => {
    for (const files of [
      [
        { path: "a", content: "x" },
        { path: "A", content: "y" },
      ],
      [
        { path: "a", content: "x" },
        { path: "a/b", content: "y" },
      ],
      [{ path: "big", content: "x".repeat(1024 * 1024 + 1) }],
    ]) {
      expect(() => prepareSkillLibraryBundle([markdown, ...files])).toThrow();
    }
  });
  it.runIf(process.platform !== "win32")("rejects symlink and hardlink imports", async () => {
    const directory = await fs.realpath(tempDirs.make("skill-links-"));
    await fs.writeFile(path.join(directory, "SKILL.md"), markdown.content);
    await fs.symlink("SKILL.md", path.join(directory, "linked"));
    await expect(readSkillLibraryTree(directory)).rejects.toThrow();
    await fs.unlink(path.join(directory, "linked"));
    await fs.link(path.join(directory, "SKILL.md"), path.join(directory, "linked"));
    await expect(readSkillLibraryTree(directory)).rejects.toThrow();
  });
  it.runIf(process.platform !== "win32")(
    "reads a regular-file tree through a symlink root while rejecting nested links",
    async () => {
      const parent = await fs.realpath(tempDirs.make("skill-root-link-"));
      const target = path.join(parent, "target");
      const linkedRoot = path.join(parent, "managed-skill");
      await fs.mkdir(path.join(target, "scripts"), { recursive: true });
      await fs.writeFile(path.join(target, "SKILL.md"), markdown.content);
      await fs.writeFile(path.join(target, "scripts/run.sh"), resource.content);
      await fs.symlink(target, linkedRoot, "dir");

      await expect(readSkillBundleTree(linkedRoot)).resolves.toMatchObject([
        { path: "SKILL.md" },
        { path: "scripts/run.sh" },
      ]);
      await fs.symlink("../SKILL.md", path.join(target, "scripts/linked"));
      await expect(readSkillBundleTree(linkedRoot)).rejects.toMatchObject({
        code: "INVALID_BUNDLE",
        message: expect.stringContaining("Skill trees cannot contain links or special files"),
      });
    },
  );
  it.runIf(process.platform !== "win32")(
    "reports a broken root path and filesystem cause",
    async () => {
      const parent = await fs.realpath(tempDirs.make("skill-broken-root-"));
      const missing = path.join(parent, "missing");
      const linkedRoot = path.join(parent, "managed-skill");
      await fs.symlink(missing, linkedRoot, "dir");

      await expect(readSkillBundleTree(linkedRoot)).rejects.toMatchObject({
        code: "INVALID_BUNDLE",
        message: expect.stringMatching(/root=.*managed-skill.*path=.*managed-skill.*ENOENT/s),
        rootPath: linkedRoot,
        failedPath: linkedRoot,
        cause: { code: "ENOENT" },
      });
    },
  );
  it("classifies a root removed after traversal with root path diagnostics", async () => {
    const parent = await fs.realpath(tempDirs.make("skill-post-walk-root-"));
    const directory = path.join(parent, "skill");
    const moved = path.join(parent, "moved");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "SKILL.md"), markdown.content);
    let removed = false;

    await expect(
      readSkillBundleTree(directory, () => {
        if (!removed) {
          renameSync(directory, moved);
          removed = true;
        }
        return true;
      }),
    ).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
      message: expect.stringMatching(/root=.*skill.*path=.*skill.*not-found/s),
      rootPath: directory,
      failedPath: directory,
      cause: { code: "not-found" },
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps unreadable nested directories fail-closed with path diagnostics",
    async () => {
      const directory = await fs.realpath(tempDirs.make("skill-unreadable-"));
      const nested = path.join(directory, "private");
      await fs.writeFile(path.join(directory, "SKILL.md"), markdown.content);
      await fs.mkdir(nested);
      await fs.chmod(nested, 0);
      try {
        await expect(readSkillBundleTree(directory)).rejects.toMatchObject({
          code: "INVALID_BUNDLE",
          message: expect.stringMatching(/path=.*private.*EACCES/s),
        });
      } finally {
        await fs.chmod(nested, 0o700);
      }
    },
  );
  it("rejects a tree beyond the path depth limit instead of silently omitting its files", async () => {
    const directory = await fs.realpath(tempDirs.make("skill-depth-"));
    await fs.writeFile(path.join(directory, "SKILL.md"), markdown.content);
    const nested = path.join(directory, ...Array<string>(16).fill("nested"));
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "data.bin"), Buffer.from([0, 255, 128]));
    await expect(readSkillLibraryTree(directory)).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
      message: "Skill tree exceeds traversal limits.",
    });
  });
});
