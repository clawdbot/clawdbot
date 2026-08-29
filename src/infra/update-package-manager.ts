// Resolves package managers for update build steps.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { readPackageManagerSpec } from "./package-json.js";
import { applyPathPrepend } from "./path-prepend.js";

// Update package-manager resolution chooses the package manager for update
// builds and can bootstrap pnpm when a managed checkout requires it.
type BuildManager = "pnpm" | "bun" | "npm";

type UpdatePackageManagerRequirement = "allow-fallback" | "require-preferred";

type UpdatePackageManagerFailureReason =
  | "preferred-manager-unavailable"
  | "pnpm-corepack-enable-failed"
  | "pnpm-corepack-missing"
  | "pnpm-npm-bootstrap-failed";

type PackageManagerCommandRunner = (
  argv: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

type ResolvedBuildManager =
  | {
      kind: "resolved";
      manager: BuildManager;
      preferred: BuildManager;
      fallback: boolean;
      env?: NodeJS.ProcessEnv;
      cleanup?: () => Promise<void>;
    }
  | {
      kind: "missing-required";
      preferred: BuildManager;
      reason: UpdatePackageManagerFailureReason;
    };

async function detectBuildManager(root: string): Promise<BuildManager> {
  return (await detectPackageManagerImpl(root)) ?? "npm";
}

function managerPreferenceOrder(preferred: BuildManager): BuildManager[] {
  if (preferred === "pnpm") {
    return ["pnpm", "npm", "bun"];
  }
  if (preferred === "bun") {
    return ["bun", "npm", "pnpm"];
  }
  return ["npm", "pnpm", "bun"];
}

async function isManagerAvailable(
  runCommand: PackageManagerCommandRunner,
  manager: BuildManager | "corepack",
  options: Parameters<PackageManagerCommandRunner>[1],
  expectedVersion?: string,
): Promise<boolean> {
  try {
    const res = await runCommand([manager, "--version"], options);
    return res.code === 0 && (!expectedVersion || res.stdout.trim() === expectedVersion);
  } catch {
    return false;
  }
}

function cloneCommandEnv(env?: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? process.env)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  ) as Record<string, string>;
}

function createPnpmCommandEnv(env: NodeJS.ProcessEnv | undefined, root: string) {
  // pnpm resolves its manifest/lock owner from these before cwd. Bind each
  // invocation to its checkout or neutral probe, so inherited context cannot
  // select a different revision after a successful version probe.
  return {
    ...cloneCommandEnv(env),
    NPM_CONFIG_WORKSPACE_DIR: root,
    npm_config_workspace_dir: root,
    PNPM_CONFIG_LOCKFILE_DIR: root,
    pnpm_config_lockfile_dir: root,
  };
}

async function resolvePnpmBuildManager(params: {
  root: string;
  preferred: BuildManager;
  version?: string;
  runCommand: PackageManagerCommandRunner;
  timeoutMs: number;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<ResolvedBuildManager> {
  let cleanup: (() => Promise<void>) | undefined;
  let retained = false;
  let reason: UpdatePackageManagerFailureReason = "preferred-manager-unavailable";
  try {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pnpm-"));
    cleanup = async () => {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    };
    const targetEnv = createPnpmCommandEnv(params.baseEnv, params.root);
    const probeOptions = {
      timeoutMs: params.timeoutMs,
      env: createPnpmCommandEnv(targetEnv, tempRoot),
      cwd: tempRoot,
    };
    const resolved = {
      kind: "resolved",
      manager: "pnpm",
      preferred: params.preferred,
      fallback: params.preferred !== "pnpm",
      env: targetEnv,
    } as const;
    // Even --version can switch pnpm and write the target lock. Both manifests
    // isolate the ambient launcher from ancestor workspace pins before selection.
    await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ private: true }));
    await fs.writeFile(path.join(tempRoot, "pnpm-workspace.yaml"), "packages: []\n");
    if (await isManagerAvailable(params.runCommand, "pnpm", probeOptions, params.version)) {
      return resolved;
    }
    reason = "pnpm-corepack-missing";
    if (await isManagerAvailable(params.runCommand, "corepack", probeOptions)) {
      reason = "pnpm-corepack-enable-failed";
      const enabled = await params
        .runCommand(["corepack", "enable", "--install-directory", tempRoot, "pnpm"], probeOptions)
        .catch(() => null);
      const env = { ...targetEnv };
      applyPathPrepend(env, [tempRoot]);
      // Only the owned Corepack shim may select a version inside the target.
      const targetOptions = { ...probeOptions, cwd: params.root, env };
      if (
        enabled?.code === 0 &&
        (await isManagerAvailable(params.runCommand, "pnpm", targetOptions, params.version))
      ) {
        retained = true;
        return { ...resolved, env, cleanup };
      }
    }
    if (params.version && (await isManagerAvailable(params.runCommand, "npm", probeOptions))) {
      reason = "pnpm-npm-bootstrap-failed";
      // npm requires project policy for the pinned native-binary provisioning script.
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({ private: true, allowScripts: { [`pnpm@${params.version}`]: true } }),
      );
      const installed = await params.runCommand(
        ["npm", "install", "--prefix", tempRoot, `pnpm@${params.version}`],
        probeOptions,
      );
      const env = { ...targetEnv };
      applyPathPrepend(env, [path.join(tempRoot, "node_modules", ".bin")]);
      if (
        installed.code === 0 &&
        (await isManagerAvailable(
          params.runCommand,
          "pnpm",
          { ...probeOptions, env: createPnpmCommandEnv(env, tempRoot) },
          params.version,
        ))
      ) {
        retained = true;
        return { ...resolved, env, cleanup };
      }
    }
  } catch {
    // Allocation and bootstrap failures share the visible failure result and cleanup owner.
  } finally {
    if (!retained) {
      await cleanup?.();
    }
  }
  return { kind: "missing-required", preferred: params.preferred, reason };
}

/** Resolve the package manager and environment to use for an update build. */
export async function resolveUpdateBuildManager(
  runCommand: PackageManagerCommandRunner,
  root: string,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
  requirement: UpdatePackageManagerRequirement = "allow-fallback",
): Promise<ResolvedBuildManager> {
  const preferred = await detectBuildManager(root);
  const pin = await readPackageManagerSpec(root);
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/u.exec(pin ?? "")?.[1];
  for (const manager of managerPreferenceOrder(preferred)) {
    if (manager === "pnpm" && (preferred === "pnpm" || pnpmVersion !== undefined)) {
      const pnpm = await resolvePnpmBuildManager({
        root,
        preferred,
        version: pnpmVersion,
        runCommand,
        timeoutMs,
        baseEnv,
      });
      if (
        pnpm.kind === "resolved" ||
        (preferred === "pnpm" && requirement === "require-preferred")
      ) {
        return pnpm;
      }
      continue;
    }
    // Alternative managers can reject the project's declared manager. A neutral
    // version probe would hide that refusal and mask a later usable alternative.
    const env = manager === "pnpm" ? createPnpmCommandEnv(baseEnv, root) : baseEnv;
    if (await isManagerAvailable(runCommand, manager, { timeoutMs, env, cwd: root })) {
      return { kind: "resolved", manager, preferred, fallback: manager !== preferred, env };
    }
  }

  if (requirement === "require-preferred") {
    return { kind: "missing-required", preferred, reason: "preferred-manager-unavailable" };
  }

  return { kind: "resolved", manager: "npm", preferred, fallback: preferred !== "npm" };
}

/** Build argv for running a package-manager script. */
export function managerScriptArgs(manager: BuildManager, script: string, args: string[] = []) {
  if (manager === "pnpm") {
    return ["pnpm", script, ...args];
  }
  if (manager === "bun") {
    return ["bun", "run", script, ...args];
  }
  if (args.length > 0) {
    return ["npm", "run", script, "--", ...args];
  }
  return ["npm", "run", script];
}

/** Build argv for installing dependencies with a package manager. */
export function managerInstallArgs(manager: BuildManager, opts?: { compatFallback?: boolean }) {
  if (manager === "pnpm") {
    return ["pnpm", "install"];
  }
  if (manager === "bun") {
    return ["bun", "install"];
  }
  if (opts?.compatFallback) {
    return ["npm", "install", "--no-package-lock", "--legacy-peer-deps"];
  }
  return ["npm", "install"];
}

/** Build argv for installing dependencies while skipping lifecycle scripts. */
export function managerInstallIgnoreScriptsArgs(manager: BuildManager): string[] | null {
  if (manager === "pnpm") {
    return ["pnpm", "install", "--ignore-scripts"];
  }
  if (manager === "bun") {
    return ["bun", "install", "--ignore-scripts"];
  }
  return ["npm", "install", "--ignore-scripts"];
}
