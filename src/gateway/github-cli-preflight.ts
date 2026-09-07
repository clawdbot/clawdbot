import { clearExecutablePathCache, resolveExecutablePath } from "../infra/executable-path.js";

const GITHUB_CLI_REQUIRED_MESSAGE =
  "GitHub CLI (`gh`) is required on the Gateway host. Install it and retry.";

export class GitHubCliUnavailableError extends Error {
  constructor() {
    super(GITHUB_CLI_REQUIRED_MESSAGE);
    this.name = "GitHubCliUnavailableError";
  }
}

export function assertGitHubCliAvailable(env: NodeJS.ProcessEnv = process.env): void {
  // Installation can change executable availability without changing PATH; re-probe on each retry.
  clearExecutablePathCache();
  if (!resolveExecutablePath("gh", { env })) {
    throw new GitHubCliUnavailableError();
  }
}
