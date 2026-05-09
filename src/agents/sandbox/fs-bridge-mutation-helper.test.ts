import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  buildPinnedWritePlan,
  SANDBOX_PINNED_MUTATION_PYTHON,
  SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES,
} from "./fs-bridge-mutation-helper.js";

function runMutation(args: string[], input?: string) {
  return spawnSync("python3", ["-c", SANDBOX_PINNED_MUTATION_PYTHON, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runMutationWithSource(source: string, args: string[], input?: string) {
  return spawnSync("python3", ["-c", source, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runWritePlan(args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  const plan = buildPinnedWritePlan({
    check: {
      target: {
        hostPath: args[1] ?? "",
        containerPath: args[1] ?? "",
        relativePath: path.posix.join(args[2] ?? "", args[3] ?? ""),
        writable: true,
      },
      options: {
        action: "write files",
        requireWritable: true,
      },
    },
    pinned: {
      mountRootPath: args[1] ?? "",
      relativeParentPath: args[2] ?? "",
      basename: args[3] ?? "",
    },
    mkdir: args[4] === "1",
  });

  return spawnSync("/bin/sh", ["-c", plan.script, "openclaw-sandbox-fs", ...(plan.args ?? [])], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

const hasAbsolutePythonCandidate = SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES.some((candidate) =>
  existsSync(candidate),
);

const FORCED_EXDEV_MUTATION_PYTHON = SANDBOX_PINNED_MUTATION_PYTHON.replace(
  "        os.rename(src_basename, dst_basename, src_dir_fd=src_parent_fd, dst_dir_fd=dst_parent_fd)",
  "        raise OSError(errno.EXDEV, 'forced EXDEV for test')\n        os.rename(src_basename, dst_basename, src_dir_fd=src_parent_fd, dst_dir_fd=dst_parent_fd)",
);

const FORCED_EXDEV_WITH_LATE_SOURCE_WRITE_MUTATION_PYTHON = FORCED_EXDEV_MUTATION_PYTHON.replace(
  "        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
  [
    "        late_parent_fd = open_dir(src_basename, dir_fd=src_parent_fd)",
    "        late_fd = None",
    "        try:",
    "            late_fd = os.open('late.txt', WRITE_FLAGS, 0o600, dir_fd=late_parent_fd)",
    "            os.write(late_fd, b'late')",
    "        finally:",
    "            if late_fd is not None:",
    "                os.close(late_fd)",
    "            os.close(late_parent_fd)",
    "        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
  ].join("\n"),
);

const FORCED_EXDEV_WITH_SOURCE_REPLACEMENT_MUTATION_PYTHON = FORCED_EXDEV_MUTATION_PYTHON.replace(
  "        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
  [
    "        replacement_parent_fd = open_dir(src_basename, dir_fd=src_parent_fd)",
    "        replacement_dir_fd = None",
    "        replacement_fd = None",
    "        try:",
    "            replacement_dir_fd = open_dir('nested', dir_fd=replacement_parent_fd)",
    "            os.unlink('file.txt', dir_fd=replacement_dir_fd)",
    "            replacement_fd = os.open('file.txt', WRITE_FLAGS, 0o600, dir_fd=replacement_dir_fd)",
    "            os.write(replacement_fd, b'replacement')",
    "        finally:",
    "            if replacement_fd is not None:",
    "                os.close(replacement_fd)",
    "            if replacement_dir_fd is not None:",
    "                os.close(replacement_dir_fd)",
    "            os.close(replacement_parent_fd)",
    "        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
  ].join("\n"),
);

describe("sandbox pinned mutation helper", () => {
  it("writes through a pinned directory fd", async () => {
    await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });

      const result = runMutation(["write", workspace, "nested/deeper", "note.txt", "1"], "hello");

      expect(result.status).toBe(0);
      await expect(
        fs.readFile(path.join(workspace, "nested", "deeper", "note.txt"), "utf8"),
      ).resolves.toBe("hello");
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves existing target file mode while writing",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        const filePath = path.join(workspace, "note.txt");
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(filePath, "before", "utf8");
        await fs.chmod(filePath, 0o644);

        const result = runMutation(["write", workspace, "", "note.txt", "0"], "after");

        expect(result.status).toBe(0);
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("after");
        const fileStat = await fs.stat(filePath);
        expect(fileStat.mode & 0o777).toBe(0o644);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps restrictive existing target file mode while writing",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        const filePath = path.join(workspace, "secret.txt");
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(filePath, "before", "utf8");
        await fs.chmod(filePath, 0o600);

        const result = runMutation(["write", workspace, "", "secret.txt", "0"], "after");

        expect(result.status).toBe(0);
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("after");
        const fileStat = await fs.stat(filePath);
        expect(fileStat.mode & 0o777).toBe(0o600);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads through a pinned directory fd and rejects hardlinked files",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        const nested = path.join(workspace, "nested");
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(workspace, "read.txt"), "hello", "utf8");

        const readResult = runMutation(["read", workspace, "", "read.txt"]);
        expect(readResult.status).toBe(0);
        expect(readResult.stdout).toBe("hello");

        const hardlinkedFile = path.join(nested, "hardlinked.txt");
        await fs.link(path.join(workspace, "read.txt"), hardlinkedFile);

        const hardlinkResult = runMutation(["read", workspace, "nested", "hardlinked.txt"]);
        expect(hardlinkResult.status).not.toBe(0);
        expect(hardlinkResult.stderr).toMatch(/hardlinked file/i);
      });
    },
  );

  it.runIf(process.platform !== "win32")("rejects non-regular files while reading", async () => {
    await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(path.join(workspace, "folder"), { recursive: true });

      const result = runMutation(["read", workspace, "", "folder"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/only regular files are allowed/i);
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves stdin payload bytes when the pinned write plan runs through sh",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace, { recursive: true });

        const result = runWritePlan(
          ["write", workspace, "nested/deeper", "note.txt", "1"],
          "hello",
          hasAbsolutePythonCandidate ? { PATH: "" } : undefined,
        );

        expect(result.status).toBe(0);
        await expect(
          fs.readFile(path.join(workspace, "nested", "deeper", "note.txt"), "utf8"),
        ).resolves.toBe("hello");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlink-parent writes instead of materializing a temp file outside the mount",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        const outside = path.join(root, "outside");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.symlink(outside, path.join(workspace, "alias"));

        const result = runMutation(["write", workspace, "alias", "escape.txt", "0"], "owned");

        expect(result.status).not.toBe(0);
        await expectPathMissing(path.join(outside, "escape.txt"));
      });
    },
  );

  it.runIf(process.platform !== "win32")("rejects symlink segments during mkdirp", async () => {
    await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, path.join(workspace, "alias"));

      const result = runMutation(["mkdirp", workspace, "alias/nested"]);

      expect(result.status).not.toBe(0);
      await expectPathMissing(path.join(outside, "nested"));
    });
  });

  it.runIf(process.platform !== "win32")("remove unlinks the symlink itself", async () => {
    await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, "secret.txt"), "classified", "utf8");
      await fs.symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));

      const result = runMutation(["remove", workspace, "", "link.txt", "0", "0"]);

      expect(result.status).toBe(0);
      await expectPathMissing(path.join(workspace, "link.txt"));
      await expect(fs.readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe(
        "classified",
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink destination parents during rename",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        const outside = path.join(root, "outside");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(path.join(workspace, "from.txt"), "payload", "utf8");
        await fs.symlink(outside, path.join(workspace, "alias"));

        const result = runMutation([
          "rename",
          workspace,
          "",
          "from.txt",
          workspace,
          "alias",
          "escape.txt",
          "1",
        ]);

        expect(result.status).not.toBe(0);
        await expect(fs.readFile(path.join(workspace, "from.txt"), "utf8")).resolves.toBe(
          "payload",
        );
        await expectPathMissing(path.join(outside, "escape.txt"));
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "copies directories across different mount roots during rename fallback",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const sourceRoot = path.join(root, "source");
        const destRoot = path.join(root, "dest");
        await fs.mkdir(path.join(sourceRoot, "dir", "nested"), { recursive: true });
        await fs.mkdir(destRoot, { recursive: true });
        await fs.writeFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "payload", "utf8");

        const result = runMutationWithSource(FORCED_EXDEV_MUTATION_PYTHON, [
          "rename",
          sourceRoot,
          "",
          "dir",
          destRoot,
          "",
          "moved",
          "1",
        ]);

        expect(result.status).toBe(0);
        await expect(
          fs.readFile(path.join(destRoot, "moved", "nested", "file.txt"), "utf8"),
        ).resolves.toBe("payload");
        await expectPathMissing(path.join(sourceRoot, "dir"));
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects hardlinked files during rename EXDEV fallback",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const sourceRoot = path.join(root, "source");
        const destRoot = path.join(root, "dest");
        const outsideRoot = path.join(root, "outside");
        await fs.mkdir(sourceRoot, { recursive: true });
        await fs.mkdir(destRoot, { recursive: true });
        await fs.mkdir(outsideRoot, { recursive: true });
        await fs.writeFile(path.join(outsideRoot, "secret.txt"), "classified", "utf8");
        await fs.link(path.join(outsideRoot, "secret.txt"), path.join(sourceRoot, "linked.txt"));

        const result = runMutationWithSource(FORCED_EXDEV_MUTATION_PYTHON, [
          "rename",
          sourceRoot,
          "",
          "linked.txt",
          destRoot,
          "",
          "copied.txt",
          "1",
        ]);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/hardlinked file/i);
        await expectPathMissing(path.join(destRoot, "copied.txt"));
        await expect(fs.readFile(path.join(outsideRoot, "secret.txt"), "utf8")).resolves.toBe(
          "classified",
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps source intact and cleans temp directories when directory rename fallback fails",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const sourceRoot = path.join(root, "source");
        const destRoot = path.join(root, "dest");
        const outsideRoot = path.join(root, "outside");
        await fs.mkdir(path.join(sourceRoot, "dir", "nested"), { recursive: true });
        await fs.mkdir(destRoot, { recursive: true });
        await fs.mkdir(outsideRoot, { recursive: true });
        await fs.writeFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "payload", "utf8");
        await fs.writeFile(path.join(outsideRoot, "secret.txt"), "classified", "utf8");
        await fs.link(
          path.join(outsideRoot, "secret.txt"),
          path.join(sourceRoot, "dir", "nested", "linked.txt"),
        );

        const result = runMutationWithSource(FORCED_EXDEV_MUTATION_PYTHON, [
          "rename",
          sourceRoot,
          "",
          "dir",
          destRoot,
          "",
          "moved",
          "1",
        ]);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/hardlinked file/i);
        await expect(
          fs.readFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "utf8"),
        ).resolves.toBe("payload");
        await expect(
          fs.readFile(path.join(sourceRoot, "dir", "nested", "linked.txt"), "utf8"),
        ).resolves.toBe("classified");
        await expectPathMissing(path.join(destRoot, "moved"));
        await expect(fs.readdir(destRoot)).resolves.toEqual([]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves source entries created after the directory rename fallback copy phase",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const sourceRoot = path.join(root, "source");
        const destRoot = path.join(root, "dest");
        await fs.mkdir(path.join(sourceRoot, "dir", "nested"), { recursive: true });
        await fs.mkdir(destRoot, { recursive: true });
        await fs.writeFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "payload", "utf8");

        const result = runMutationWithSource(FORCED_EXDEV_WITH_LATE_SOURCE_WRITE_MUTATION_PYTHON, [
          "rename",
          sourceRoot,
          "",
          "dir",
          destRoot,
          "",
          "moved",
          "1",
        ]);

        expect(result.status).not.toBe(0);
        await expect(
          fs.readFile(path.join(destRoot, "moved", "nested", "file.txt"), "utf8"),
        ).resolves.toBe("payload");
        await expect(fs.readFile(path.join(sourceRoot, "dir", "late.txt"), "utf8")).resolves.toBe(
          "late",
        );
        await expect(
          fs.readFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "utf8"),
        ).resolves.toBe("payload");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves source entries replaced after the directory rename fallback copy phase",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const sourceRoot = path.join(root, "source");
        const destRoot = path.join(root, "dest");
        await fs.mkdir(path.join(sourceRoot, "dir", "nested"), { recursive: true });
        await fs.mkdir(destRoot, { recursive: true });
        await fs.writeFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "payload", "utf8");

        const result = runMutationWithSource(FORCED_EXDEV_WITH_SOURCE_REPLACEMENT_MUTATION_PYTHON, [
          "rename",
          sourceRoot,
          "",
          "dir",
          destRoot,
          "",
          "moved",
          "1",
        ]);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/source changed during move fallback cleanup/i);
        await expect(
          fs.readFile(path.join(destRoot, "moved", "nested", "file.txt"), "utf8"),
        ).resolves.toBe("payload");
        await expect(
          fs.readFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "utf8"),
        ).resolves.toBe("replacement");
      });
    },
  );
});
