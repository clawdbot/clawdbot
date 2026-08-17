const FULL_GIT_COMMIT_RE = /^[0-9a-f]{40}$/iu;

type BuildIdentityOptions = {
  commitLabel: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readGitCommit: () => string | null;
};

/** Pins one timestamp and source commit across every child in a build lifecycle. */
export function resolveBuildIdentityEnvironment({
  commitLabel,
  env = process.env,
  now = () => new Date(),
  readGitCommit,
}: BuildIdentityOptions): NodeJS.ProcessEnv {
  const explicitTimestamp = env.OPENCLAW_BUILD_TIMESTAMP?.trim();
  const explicitCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const checkedOutCommit = explicitCommit ? null : readGitCommit()?.trim();
  // GITHUB_SHA names the workflow invocation and can differ from a checked-out tag.
  const commit = explicitCommit || checkedOutCommit || env.GITHUB_SHA?.trim();
  if (commit && !FULL_GIT_COMMIT_RE.test(commit)) {
    throw new Error(`${commitLabel} must be a full 40-character hexadecimal SHA`);
  }
  return {
    ...env,
    OPENCLAW_BUILD_TIMESTAMP: explicitTimestamp || now().toISOString(),
    ...(commit ? { GIT_COMMIT: commit.toLowerCase() } : {}),
  };
}
