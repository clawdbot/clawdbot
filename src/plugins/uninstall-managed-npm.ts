import {
  type ManagedNpmOverrideOmissions,
  syncManagedNpmRootPeerDependencies,
} from "../infra/npm-managed-root.js";
import { createSafeNpmInstallEnv } from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { classifyNpmManagedOverrideCompatibilityError } from "./install-managed-npm-state.js";

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
  let overrideOmissions: Required<ManagedNpmOverrideOmissions> = {
    npmAliases: false,
    pnpmParentChildSelectors: false,
  };
  const syncPeerDependencies = async () =>
    await syncManagedNpmRootPeerDependencies({
      npmRoot: params.npmRoot,
      managedOverrides: params.managedOverrides,
      overrideOmissions,
      runCommand: command,
    });

  if (!(await syncPeerDependencies())) {
    return undefined;
  }

  let cleanup = await command([...MANAGED_NPM_PEER_CLEANUP_ARGS], commandOptions);
  while (cleanup.code !== 0) {
    const compatibility = classifyNpmManagedOverrideCompatibilityError(cleanup);
    if (!compatibility) {
      break;
    }
    const nextOverrideOmissions = {
      npmAliases: overrideOmissions.npmAliases || compatibility.npmAliases,
      pnpmParentChildSelectors:
        overrideOmissions.pnpmParentChildSelectors || compatibility.pnpmParentChildSelectors,
    };
    if (
      nextOverrideOmissions.npmAliases === overrideOmissions.npmAliases &&
      nextOverrideOmissions.pnpmParentChildSelectors === overrideOmissions.pnpmParentChildSelectors
    ) {
      break;
    }
    overrideOmissions = nextOverrideOmissions;
    // The first sync can only rewrite a manifest that npm rejected. Run the
    // plan again against that compatible manifest so peer pins are refreshed.
    await syncPeerDependencies();
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
