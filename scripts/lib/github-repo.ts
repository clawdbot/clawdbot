import { execFileSync } from "node:child_process";
import hostedGitInfo from "hosted-git-info";

export function normalizeGitHubRepo(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = /^github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  const info = hostedGitInfo.fromUrl(candidate);
  return info?.type === "github" && info.user && info.project
    ? `${info.user}/${info.project}`
    : null;
}

export function resolveGitHubRepoFromOrigin(): string {
  const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!remote) {
    throw new Error("Unable to determine repository from git remote.");
  }

  const repo = normalizeGitHubRepo(remote);
  if (!repo) {
    throw new Error(`Unsupported GitHub remote: ${remote}`);
  }
  return repo;
}
