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
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  expectedVersion?: string,
): Promise<boolean> {
  try {
    const res = await runCommand([manager, "--version"], { timeoutMs, env });
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

async function enablePnpmViaCorepack(
  runCommand: PackageManagerCommandRunner,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  expectedVersion?: string,
): Promise<"enabled" | "missing" | "failed"> {
  if (!(await isManagerAvailable(runCommand, "corepack", timeoutMs, env))) {
    return "missing";
  }
  try {
    const res = await runCommand(["corepack", "enable"], { timeoutMs, env });
    if (res.code !== 0) {
      return "failed";
    }
  } catch {
    return "failed";
  }
  return (await isManagerAvailable(runCommand, "pnpm", timeoutMs, env, expectedVersion))
    ? "enabled"
    : "failed";
}

async function bootstrapPnpmViaNpm(params: {
  version: string;
  runCommand: PackageManagerCommandRunner;
  timeoutMs: number;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> } | null> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pnpm-"));
  const cleanup = async () => {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  };
  try {
    // npm 11.16+ requires project policy for local installs; only this pinned
    // tool may run its native-binary provisioning script in the temporary prefix.
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        private: true,
        allowScripts: { [`pnpm@${params.version}`]: true },
      }),
    );
    const installResult = await params.runCommand(
      ["npm", "install", "--prefix", tempRoot, `pnpm@${params.version}`],
      {
        timeoutMs: params.timeoutMs,
        env: params.baseEnv,
      },
    );
    if (installResult.code !== 0) {
      await cleanup();
      return null;
    }
    const env = cloneCommandEnv(params.baseEnv);
    applyPathPrepend(env, [path.join(tempRoot, "node_modules", ".bin")]);
    if (
      !(await isManagerAvailable(params.runCommand, "pnpm", params.timeoutMs, env, params.version))
    ) {
      await cleanup();
      return null;
    }
    return { env, cleanup };
  } catch {
    await cleanup();
    return null;
  }
}

/** Resolve the package manager and environment to use for an update build. */
export async function resolveUpdateBuildManager(
  commandRunner: PackageManagerCommandRunner,
  root: string,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
  requirement: UpdatePackageManagerRequirement = "allow-fallback",
): Promise<ResolvedBuildManager> {
  // Version selection belongs to the target checkout, including preflight and rollback.
  const runCommand: PackageManagerCommandRunner = (argv, options) =>
    commandRunner(argv, { ...options, cwd: root });
  const preferred = await detectBuildManager(root);
  const pin = await readPackageManagerSpec(root);
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/u.exec(pin ?? "")?.[1];
  if (preferred === "pnpm") {
    if (await isManagerAvailable(runCommand, "pnpm", timeoutMs, baseEnv, pnpmVersion)) {
      return { kind: "resolved", manager: "pnpm", preferred, fallback: false };
    }

    const corepackStatus = await enablePnpmViaCorepack(runCommand, timeoutMs, baseEnv, pnpmVersion);
    if (corepackStatus === "enabled") {
      return { kind: "resolved", manager: "pnpm", preferred, fallback: false };
    }

    const npmAvailable = await isManagerAvailable(runCommand, "npm", timeoutMs, baseEnv);
    if (npmAvailable && pnpmVersion) {
      const pnpmBootstrap = await bootstrapPnpmViaNpm({
        version: pnpmVersion,
        runCommand,
        timeoutMs,
        baseEnv,
      });
      if (pnpmBootstrap) {
        return {
          kind: "resolved",
          manager: "pnpm",
          preferred,
          fallback: false,
          env: pnpmBootstrap.env,
          cleanup: pnpmBootstrap.cleanup,
        };
      }
      if (requirement === "require-preferred") {
        return { kind: "missing-required", preferred, reason: "pnpm-npm-bootstrap-failed" };
      }
    }

    if (requirement === "require-preferred") {
      if (corepackStatus === "missing") {
        return { kind: "missing-required", preferred, reason: "pnpm-corepack-missing" };
      }
      if (corepackStatus === "failed") {
        return { kind: "missing-required", preferred, reason: "pnpm-corepack-enable-failed" };
      }
      return { kind: "missing-required", preferred, reason: "preferred-manager-unavailable" };
    }
  }

  for (const manager of managerPreferenceOrder(preferred)) {
    if (
      await isManagerAvailable(
        runCommand,
        manager,
        timeoutMs,
        baseEnv,
        manager === "pnpm" ? pnpmVersion : undefined,
      )
    ) {
      return { kind: "resolved", manager, preferred, fallback: manager !== preferred };
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
