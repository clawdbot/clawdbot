import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import type { NpmSpecResolution } from "./install-source-utils.js";
import { readJson, readJsonIfExists, writeJson } from "./json-files.js";
import type { ParsedRegistryNpmSpec } from "./npm-registry-spec.js";
import { createSafeNpmInstallEnv } from "./safe-package-install.js";

type ManagedNpmRootManifest = {
  private?: boolean;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

export type ManagedNpmRootInstalledDependency = {
  version?: string;
  integrity?: string;
  resolved?: string;
};

type ManagedNpmRootLockfile = {
  packages?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  [key: string]: unknown;
};

type ManagedNpmRootLogger = {
  warn?: (message: string) => void;
};

type ManagedNpmRootRunCommand = typeof runCommandWithTimeout;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDependencyRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const dependencies: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      dependencies[key] = raw;
    }
  }
  return dependencies;
}

async function readManagedNpmRootManifest(filePath: string): Promise<ManagedNpmRootManifest> {
  const parsed = await readJsonIfExists<unknown>(filePath);
  return isRecord(parsed) ? { ...parsed } : {};
}

export function resolveManagedNpmRootDependencySpec(params: {
  parsedSpec: ParsedRegistryNpmSpec;
  resolution: NpmSpecResolution;
}): string {
  return params.resolution.version ?? params.parsedSpec.selector ?? "latest";
}

export async function upsertManagedNpmRootDependency(params: {
  npmRoot: string;
  packageName: string;
  dependencySpec: string;
}): Promise<void> {
  await fs.mkdir(params.npmRoot, { recursive: true });
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: {
      ...dependencies,
      [params.packageName]: params.dependencySpec,
    },
  };
  await writeJson(manifestPath, next, { trailingNewline: true });
}

export async function repairManagedNpmRootOpenClawPeer(params: {
  npmRoot: string;
  timeoutMs?: number;
  logger?: ManagedNpmRootLogger;
  runCommand?: ManagedNpmRootRunCommand;
}): Promise<boolean> {
  await fs.mkdir(params.npmRoot, { recursive: true });

  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  const hasManifestDependency = "openclaw" in dependencies;
  const hasLockDependency = await managedNpmRootLockfileHasOpenClawPeer(params.npmRoot);
  const hasPackageDir = await pathExists(path.join(params.npmRoot, "node_modules", "openclaw"));
  if (!hasManifestDependency && !hasLockDependency && !hasPackageDir) {
    return false;
  }

  const command = params.runCommand ?? runCommandWithTimeout;
  const npmArgs = hasManifestDependency
    ? [
        "npm",
        "uninstall",
        "--loglevel=error",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        ".",
        "openclaw",
      ]
    : [
        "npm",
        "prune",
        "--loglevel=error",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        ".",
      ];
  try {
    const result = await command(npmArgs, {
      cwd: params.npmRoot,
      timeoutMs: Math.max(params.timeoutMs ?? 300_000, 300_000),
      env: createSafeNpmInstallEnv(process.env, {
        legacyPeerDeps: true,
        packageLock: true,
        quiet: true,
      }),
    });
    if (result.code !== 0) {
      params.logger?.warn?.(
        `npm ${hasManifestDependency ? "uninstall openclaw" : "prune"} failed while repairing managed npm root; falling back to direct cleanup: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  } catch (error) {
    params.logger?.warn?.(
      `npm ${hasManifestDependency ? "uninstall openclaw" : "prune"} failed while repairing managed npm root; falling back to direct cleanup: ${String(error)}`,
    );
  }

  await scrubManagedNpmRootOpenClawPeer({ npmRoot: params.npmRoot });
  return true;
}

async function managedNpmRootLockfileHasOpenClawPeer(npmRoot: string): Promise<boolean> {
  const lockPath = path.join(npmRoot, "package-lock.json");
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as ManagedNpmRootLockfile;
    if (isRecord(parsed.packages)) {
      const rootPackage = parsed.packages[""];
      if (
        isRecord(rootPackage) &&
        isRecord(rootPackage.dependencies) &&
        "openclaw" in rootPackage.dependencies
      ) {
        return true;
      }
      if ("node_modules/openclaw" in parsed.packages) {
        return true;
      }
    }
    return isRecord(parsed.dependencies) && "openclaw" in parsed.dependencies;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs
    .lstat(filePath)
    .then(() => true)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        return false;
      }
      throw err;
    });
}

async function scrubManagedNpmRootOpenClawPeer(params: { npmRoot: string }): Promise<void> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  if ("openclaw" in dependencies) {
    const { openclaw: _removed, ...nextDependencies } = dependencies;
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, private: true, dependencies: nextDependencies }, null, 2)}\n`,
      "utf8",
    );
  }

  const lockPath = path.join(params.npmRoot, "package-lock.json");
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as ManagedNpmRootLockfile;
    let lockChanged = false;
    if (isRecord(parsed.packages)) {
      const rootPackage = parsed.packages[""];
      if (isRecord(rootPackage) && isRecord(rootPackage.dependencies)) {
        const dependencies = { ...rootPackage.dependencies };
        if ("openclaw" in dependencies) {
          delete dependencies.openclaw;
          parsed.packages[""] = { ...rootPackage, dependencies };
          lockChanged = true;
        }
      }
      if ("node_modules/openclaw" in parsed.packages) {
        delete parsed.packages["node_modules/openclaw"];
        lockChanged = true;
      }
    }
    if (isRecord(parsed.dependencies) && "openclaw" in parsed.dependencies) {
      const dependencies = { ...parsed.dependencies };
      delete dependencies.openclaw;
      parsed.dependencies = dependencies;
      lockChanged = true;
    }
    if (lockChanged) {
      await fs.writeFile(lockPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const openclawPackageDir = path.join(params.npmRoot, "node_modules", "openclaw");
  if (await pathExists(openclawPackageDir)) {
    await fs.rm(openclawPackageDir, { recursive: true, force: true });
  }
  const binDir = path.join(params.npmRoot, "node_modules", ".bin");
  await Promise.all(
    ["openclaw", "openclaw.cmd", "openclaw.ps1"].map((binName) =>
      fs.rm(path.join(binDir, binName), { force: true }),
    ),
  );
  await fs.rm(path.join(params.npmRoot, "node_modules", ".package-lock.json"), {
    force: true,
  });
}

export async function readManagedNpmRootInstalledDependency(params: {
  npmRoot: string;
  packageName: string;
}): Promise<ManagedNpmRootInstalledDependency | null> {
  const lockPath = path.join(params.npmRoot, "package-lock.json");
  const parsed = await readJson<unknown>(lockPath);
  if (!isRecord(parsed) || !isRecord(parsed.packages)) {
    return null;
  }
  const entry = parsed.packages[`node_modules/${params.packageName}`];
  if (!isRecord(entry)) {
    return null;
  }
  return {
    version: readOptionalString(entry.version),
    integrity: readOptionalString(entry.integrity),
    resolved: readOptionalString(entry.resolved),
  };
}

export async function removeManagedNpmRootDependency(params: {
  npmRoot: string;
  packageName: string;
}): Promise<void> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  if (!(params.packageName in dependencies)) {
    return;
  }
  const { [params.packageName]: _removed, ...nextDependencies } = dependencies;
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: nextDependencies,
  };
  await writeJson(manifestPath, next, { trailingNewline: true });
}
