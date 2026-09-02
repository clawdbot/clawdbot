import os from "node:os";

export function gitTransportUnsafeConfigArgs(scope: "--local" | "--worktree"): string[] {
  return [
    "git",
    "config",
    scope,
    "--includes",
    "--get-regexp",
    "^(core\\.(alternaterefscommand|askpass|fsmonitor|gitproxy|sshcommand|worktree)|credential\\..*helper|filter\\..*|http\\..*|include(if)?\\..*|push\\..*|remote\\..*\\.(proxy|receivepack|uploadpack|vcs)|uploadpack\\.packobjectshook|url\\..*\\.(insteadof|pushinsteadof))$",
  ];
}

/** Share the transport preflight for publication and managed-project refresh. */
export async function assertSafeGitTransportConfig(
  cwd: string,
  run: (
    argv: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<{ code: number | null; stdout: Buffer }>,
): Promise<void> {
  const isolatedConfig = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull };
  const [localUnsafe, worktreeConfig] = await Promise.all([
    run(gitTransportUnsafeConfigArgs("--local"), { cwd, env: isolatedConfig }),
    run(
      ["git", "config", "--local", "--includes", "--bool", "--get", "extensions.worktreeConfig"],
      { cwd, env: isolatedConfig },
    ),
  ]);
  const worktreeConfigValue = worktreeConfig.stdout.toString("utf8").trim();
  const worktreeConfigKnown =
    (worktreeConfig.code === 0 &&
      (worktreeConfigValue === "true" || worktreeConfigValue === "false")) ||
    (worktreeConfig.code === 1 && worktreeConfig.stdout.length === 0);
  if (localUnsafe.code !== 1 || localUnsafe.stdout.length > 0 || !worktreeConfigKnown) {
    throw new Error("Git workspace has unsupported Git transport configuration.");
  }
  const worktreeUnsafe =
    worktreeConfigValue === "true"
      ? await run(gitTransportUnsafeConfigArgs("--worktree"), {
          cwd,
          env: isolatedConfig,
        })
      : undefined;
  if (worktreeUnsafe && (worktreeUnsafe.code !== 1 || worktreeUnsafe.stdout.length > 0)) {
    throw new Error("Git workspace has unsupported Git transport configuration.");
  }
}
