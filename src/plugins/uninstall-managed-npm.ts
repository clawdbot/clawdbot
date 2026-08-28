import { syncManagedNpmRootPeerDependencies } from "../infra/npm-managed-root.js";
import { createSafeNpmInstallEnv } from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isNpmAliasOverrideCompatibilityError } from "./install-managed-npm-state.js";

const MANAGED_NPM_PEER_CLEANUP_ARGS = [
  "npm",
  "install",
  "--omit=dev",
  "--omit=peer",
  "--loglevel=error",
  "--legacy-peer-deps",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
] as const;

export async function pruneManagedNpmPeerDependenciesAfterUninstall(params: {
  npmRoot: string;
  packageName: string;
  managedOverrides: Record<string, unknown>;
  runCommand?: typeof runCommandWithTimeout;
}): Promise<string | undefined> {
  const command = params.runCommand ?? runCommandWithTimeout;
  const commandOptions = {
    cwd: params.npmRoot,
    timeoutMs: 300_000,
    env: createSafeNpmInstallEnv(process.env, {
      legacyPeerDeps: true,
      npmConfigCwd: params.npmRoot,
      packageLock: true,
      quiet: true,
    }),
  };
  let omitNpmAliasOverrides = false;
  const syncPeerDependencies = async () =>
    await syncManagedNpmRootPeerDependencies({
      npmRoot: params.npmRoot,
      managedOverrides: params.managedOverrides,
      omitNpmAliasOverrides,
      runCommand: command,
    });

  if (!(await syncPeerDependencies())) {
    return undefined;
  }

  let cleanup = await command([...MANAGED_NPM_PEER_CLEANUP_ARGS], commandOptions);
  if (cleanup.code !== 0 && isNpmAliasOverrideCompatibilityError(cleanup)) {
    omitNpmAliasOverrides = true;
    await syncPeerDependencies();
    cleanup = await command([...MANAGED_NPM_PEER_CLEANUP_ARGS], commandOptions);
  }

  if (cleanup.code === 0) {
    return undefined;
  }
  return `Failed to prune managed peer dependencies after uninstalling ${params.packageName}: ${
    cleanup.stderr.trim() || cleanup.stdout.trim() || `npm exited with code ${cleanup.code}`
  }`;
}
