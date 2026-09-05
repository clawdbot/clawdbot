import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import type { CommandRunner } from "./update-runner-types.js";
import { relocateRuntimeSymlink, type RuntimeRelocation } from "./update-runtime-relocation.js";

async function collectRuntimeDirectories(
  root: string,
  runCommand: CommandRunner,
  timeoutMs: number,
) {
  const result = await runCommand(
    [
      "git",
      "-C",
      root,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      "--",
      "dist",
      "node_modules",
      "**/dist",
      "**/node_modules",
      ":(exclude).artifacts/**",
      ":(exclude).worktrees/**",
      ":(exclude).claude/**",
    ],
    { cwd: root, timeoutMs },
  );
  if (result.code !== 0) {
    throw new Error("Cannot enumerate candidate runtime outputs");
  }
  return (
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.replace(/\/$/u, ""))
      // Git's --directory can collapse an excluded subtree to its ignored parent.
      .filter(
        (entry) =>
          ["dist", "node_modules"].includes(path.basename(entry)) &&
          !entry.split("/").some((part) => part.startsWith(".")),
      )
  );
}

async function rebindRuntimeLinks(
  staged: string,
  relative: string,
  relocation: RuntimeRelocation,
): Promise<void> {
  const stat = await fs.lstat(staged);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(staged, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await rebindRuntimeLinks(
          path.join(staged, entry.name),
          path.join(relative, entry.name),
          relocation,
        );
      }
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    await relocateRuntimeSymlink(
      staged,
      path.join(relocation.sourceRoot, relative),
      path.join(relocation.destinationRoot, relative),
      relocation,
    );
  }
}

/** Stage on the destination filesystem; activation only renames the already validated runtime. */
export async function prepareGitRuntimePromotion(
  root: string,
  candidateRoot: string,
  runCommand: CommandRunner,
  timeoutMs: number,
) {
  const directories = await collectRuntimeDirectories(candidateRoot, runCommand, timeoutMs);
  const relocation: RuntimeRelocation = {
    sourceRoot: await fs.realpath(candidateRoot),
    destinationRoot: await fs.realpath(root),
    sourceAliases: [candidateRoot],
  };
  const staged: Array<{ destination: string; temporary: string; previous: boolean }> = [];
  const promoted: typeof staged = [];
  const cleanup = async () => {
    await Promise.all(
      staged.map((entry) => fs.rm(entry.temporary, { recursive: true, force: true })),
    );
  };
  try {
    for (const relative of directories) {
      const destination = path.join(root, relative);
      // .artifacts may point at another volume. A sibling of each destination
      // guarantees rename-only activation, including nested workspace outputs.
      const temporary = `${destination}.openclaw-update-${randomUUID()}.tmp`;
      const entry = { destination, temporary, previous: false };
      staged.push(entry);
      await fs.mkdir(temporary, { recursive: true });
      const candidate = path.join(temporary, "candidate");
      await fs.cp(path.join(candidateRoot, relative), candidate, {
        recursive: true,
        verbatimSymlinks: true,
      });
      await rebindRuntimeLinks(candidate, relative, relocation);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    async activate() {
      for (const entry of staged) {
        try {
          await fs.rename(entry.destination, path.join(entry.temporary, "previous"));
          entry.previous = true;
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
        }
        promoted.push(entry);
        await fs.rename(path.join(entry.temporary, "candidate"), entry.destination);
      }
    },
    async restore() {
      for (const entry of promoted.toReversed()) {
        await fs.rm(entry.destination, { recursive: true, force: true });
        if (entry.previous) {
          await fs.rename(path.join(entry.temporary, "previous"), entry.destination);
        }
      }
      promoted.length = 0;
    },
    cleanup,
  };
}
