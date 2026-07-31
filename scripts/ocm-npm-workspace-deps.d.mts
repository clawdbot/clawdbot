#!/usr/bin/env node
export function parseWorkspaceDependencyDirs(raw?: string, cwd?: string): string[];
export function resolveWorkspaceInstallPlan(
  args: unknown,
  workspaceDirs: unknown,
  cwd?: string,
): {
  installArgs: unknown;
  prefixDir: string;
  rootArchive: string;
} | null;
export function buildInstallManifest(
  rootArchive: unknown,
  workspacePackages: unknown,
): {
  private: boolean;
  dependencies: {
    openclaw: string;
  };
};
export function resolveNpmEnvironment(args: string[], env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function resolveRuntimePackPlan(
  args: string[],
  env?: NodeJS.ProcessEnv,
): { profile: string; packArgs: string[] } | null;
export function resolveRuntimePackEnvironment(
  env?: NodeJS.ProcessEnv,
  now?: () => Date,
  readGitCommit?: () => string | null,
): NodeJS.ProcessEnv & { OPENCLAW_BUILD_TIMESTAMP: string; GIT_COMMIT?: string };
export function rewriteWorkspaceDependencyVersions(
  packageJson: unknown,
  workspacePackages: unknown,
): number;
