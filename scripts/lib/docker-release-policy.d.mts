export type DockerReleaseChannel = "stable" | "extended-stable" | "beta";

export type DockerReleaseAliases = {
  default: readonly string[];
  slim: readonly string[];
  browser: readonly string[];
};

export type DockerReleasePolicy = {
  version: string;
  channel: DockerReleaseChannel;
  movingAliases: DockerReleaseAliases;
};

export function resolveDockerReleasePolicy(version: string): DockerReleasePolicy;
