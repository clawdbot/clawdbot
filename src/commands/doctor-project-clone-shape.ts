import { note } from "../../packages/terminal-core/src/note.js";
import { gitEnvironment } from "../agents/worktrees/git.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import type { OpenClawConfig } from "../config/config.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { executeGitCommand } from "../infra/git-exec.js";
import { listProjectRegistry } from "../projects/project-registry.js";

const CHECK_ID = "core/doctor/project-clone-shape";

async function readCloneGit(root: string, args: string[], optional = false): Promise<string> {
  const result = await executeGitCommand(root, args, {
    env: gitEnvironment({ ...process.env, GIT_NO_LAZY_FETCH: "1" }),
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  });
  if (
    result.termination !== "exit" ||
    result.stdoutTruncatedBytes ||
    (result.code !== 0 && !(optional && result.code === 1))
  ) {
    throw new Error("clone inspection unavailable");
  }
  return result.stdout;
}

export async function collectProjectCloneShapeHealthFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  let projects;
  try {
    projects = listProjectRegistry(cfg).filter((project) => project.source === "cloned");
  } catch {
    return [
      {
        checkId: CHECK_ID,
        severity: "warning",
        message: "Skipped project clone inspection: the project registry is unreadable.",
        fixHint: "Restore access to the project registry and rerun openclaw doctor.",
      },
    ];
  }
  for (const project of projects) {
    try {
      const config = await readCloneGit(
        project.repoRoot,
        ["config", "--null", "--get-regexp", "^remote\\..*\\.(promisor|partialclonefilter)$"],
        true,
      );
      const shallow = (
        await readCloneGit(project.repoRoot, ["rev-parse", "--is-shallow-repository"])
      ).trim();
      const extension = await readCloneGit(
        project.repoRoot,
        ["config", "--get", "extensions.partialclone"],
        true,
      );
      const keys = [
        ...new Set(
          config
            .split("\0")
            .filter(Boolean)
            .map((entry) => entry.split("\n", 1)[0]!),
        ),
      ].toSorted();
      if (extension) {
        keys.push("extensions.partialclone");
      }
      if (shallow !== "true" && keys.length === 0) {
        continue;
      }
      const unset = (key: string) => `git config --unset-all ${quoteCliArg(key)}`;
      findings.push({
        checkId: CHECK_ID,
        severity: "warning",
        path: project.repoRoot,
        message: `Project clone ${project.displayName} (${project.id}): shallow=${shallow}; partial-clone keys: ${keys.join(", ") || "none"}. Full clones are recommended for managed worktrees.`,
        fixHint: [
          "Manual repair only (POSIX shell); stop on any failed step:",
          `cd ${quoteCliArg(project.repoRoot)}`,
          ...keys.filter((key) => key.endsWith(".partialclonefilter")).map(unset),
          `git fetch --refetch${shallow === "true" ? " --unshallow" : ""} origin`,
          "git rev-list --objects --missing=print --all | grep '^?' | cut -c2- | git fetch origin --no-tags --no-write-fetch-head --recurse-submodules=no --stdin",
          ...keys
            .filter((key) => key.endsWith(".promisor") || key === "extensions.partialclone")
            .map(unset),
          "git repack -a -d",
          "Rerun openclaw doctor. If history or objects remain missing, recover them from the original repository.",
        ].join("\n"),
      });
    } catch {
      findings.push({
        checkId: CHECK_ID,
        severity: "warning",
        path: project.repoRoot,
        message: `Skipped project clone ${project.displayName} (${project.id}): repository is missing, unreadable, or Git inspection did not complete.`,
        fixHint:
          "Check the clone path, permissions, and Git installation, then rerun openclaw doctor.",
      });
    }
  }
  return findings;
}

export async function noteProjectCloneShape(cfg: OpenClawConfig): Promise<void> {
  for (const finding of await collectProjectCloneShapeHealthFindings(cfg)) {
    note(
      [finding.message, finding.path, finding.fixHint].filter(Boolean).join("\n"),
      "Project clones",
    );
  }
}
