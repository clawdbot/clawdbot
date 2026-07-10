// Package Artifact script supports OpenClaw repository automation.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sleep as delay } from "../../lib/sleep.mjs";
import { readPositiveIntEnv } from "./env-limits.ts";
import { exists, readJson } from "./filesystem.ts";
import { die, repoRoot, run, say, sh } from "./host-command.ts";
import type { PackageArtifact } from "./types.ts";

export async function extractPackageJsonFromTgz<T>(tgzPath: string, entry: string): Promise<T> {
  const output = run("tar", ["-xOf", tgzPath, entry], { quiet: true }).stdout;
  return JSON.parse(output) as T;
}

export async function packageVersionFromTgz(tgzPath: string): Promise<string> {
  const pkg = await extractPackageJsonFromTgz<{ version: string }>(tgzPath, "package/package.json");
  return pkg.version;
}

export async function packageBuildCommitFromTgz(tgzPath: string): Promise<string> {
  const info = await extractPackageJsonFromTgz<{ commit?: string }>(
    tgzPath,
    "package/dist/build-info.json",
  );
  return info.commit ?? "";
}

function resolveNpmPackTarballFilename(value: unknown): string {
  // npm 10/11 return arrays; npm 12 keys local-workspace results by package name.
  const result = Array.isArray(value)
    ? value.at(-1)
    : value && typeof value === "object" && "openclaw" in value
      ? value.openclaw
      : value;
  const filename =
    result &&
    typeof result === "object" &&
    "filename" in result &&
    typeof result.filename === "string"
      ? result.filename.trim()
      : "";
  if (
    !filename.endsWith(".tgz") ||
    filename.includes("\0") ||
    filename !== path.basename(filename) ||
    filename !== path.win32.basename(filename)
  ) {
    die("npm pack did not report a safe tarball filename");
  }
  return filename;
}

export function resolveOpenClawRegistryVersion(specOrAlias: string): string {
  const rawValue = specOrAlias.trim();
  const value = rawValue.startsWith("openclaw@") ? rawValue.slice("openclaw@".length) : rawValue;
  if (!value) {
    return "";
  }
  if (value === "latest" || value === "beta" || /^\d/.test(value)) {
    return npmViewVersion(`openclaw@${value}`);
  }
  const betaMatch = /^beta(\d+)$/u.exec(value);
  if (betaMatch) {
    const betaSuffix = `-beta.${betaMatch[1]}`;
    const versions = JSON.parse(
      run("npm", ["view", "openclaw", "versions", "--json"], { quiet: true }).stdout,
    ) as string[];
    const match = versions
      .filter((version) => version.endsWith(betaSuffix))
      .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
    if (!match) {
      die(`no openclaw registry version found for alias ${value}`);
    }
    return match;
  }
  return "";
}

function npmViewVersion(spec: string): string {
  return run("npm", ["view", spec, "version"], { quiet: true }).stdout.trim();
}

async function ensureCurrentBuildUnlocked(input: {
  requireControlUi?: boolean;
  checkDirty?: boolean;
}): Promise<void> {
  const head = run("git", ["rev-parse", "HEAD"], { quiet: true }).stdout.trim();
  const buildInfoPath = path.join(repoRoot, "dist/build-info.json");
  let buildCommit = "";
  if (await exists(buildInfoPath)) {
    buildCommit = (await readJson<{ commit?: string }>(buildInfoPath)).commit ?? "";
  }
  const dirty =
    input.checkDirty !== false &&
    run(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        "src",
        "ui",
        "packages",
        "extensions",
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig*.json",
      ],
      { quiet: true },
    ).stdout.trim() !== "";
  const controlReady =
    !input.requireControlUi ||
    ((await exists(path.join(repoRoot, "dist/control-ui/index.html"))) &&
      sh("compgen -G 'dist/control-ui/assets/*' >/dev/null", { check: false, quiet: true })
        .status === 0);
  if (buildCommit === head && !dirty && controlReady) {
    return;
  }
  say("Build dist for current head");
  run("pnpm", ["build"]);
  if (input.requireControlUi) {
    say("Build Control UI for current head");
    run("pnpm", ["ui:build"]);
  }
  const drift = run(
    "git",
    ["status", "--porcelain", "--", ":(glob)extensions/*/src/host/**/.bundle.hash"],
    {
      quiet: true,
    },
  ).stdout.trim();
  if (drift) {
    die(`generated file drift after build; commit or revert before Parallels packaging:\n${drift}`);
  }
}

export async function packOpenClaw(input: {
  destination: string;
  packageSpec?: string;
  requireControlUi?: boolean;
}): Promise<PackageArtifact> {
  await mkdir(input.destination, { recursive: true });
  if (input.packageSpec) {
    say(`Pack target package tgz: ${input.packageSpec}`);
    const output = run(
      "npm",
      [
        "pack",
        input.packageSpec,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        input.destination,
      ],
      { quiet: true },
    ).stdout;
    const packed = resolveNpmPackTarballFilename(JSON.parse(output));
    const tgzPath = path.join(input.destination, packed);
    const version = await packageVersionFromTgz(tgzPath);
    say(`Packed ${tgzPath}`);
    say(`Target package version: ${version}`);
    return { path: tgzPath, version };
  }

  return await withPackageLock(path.join(tmpdir(), "openclaw-parallels-build.lock"), async () => {
    await ensureCurrentBuildUnlocked({
      checkDirty: true,
      requireControlUi: input.requireControlUi,
    });
    const shortHead = run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim();
    const tgzPath = path.join(input.destination, `openclaw-main-${shortHead}.tgz`);
    // The canonical helper inventories the package, bundles private workspace runtime code,
    // and rejects tarballs that still depend on unpublished workspace packages.
    const packedPath = run(
      "node",
      [
        "scripts/package-openclaw-for-docker.mjs",
        "--skip-build",
        "--source-dir",
        repoRoot,
        "--output-dir",
        input.destination,
        "--output-name",
        path.basename(tgzPath),
        "--pnpm-pack",
      ],
      { quiet: true },
    ).stdout.trim();
    if (path.resolve(packedPath) !== path.resolve(tgzPath)) {
      die(`package helper wrote an unexpected tarball: ${packedPath}`);
    }
    const buildCommit = await packageBuildCommitFromTgz(tgzPath);
    if (!buildCommit) {
      die(`failed to read packed build commit from ${tgzPath}`);
    }
    say(`Packed ${tgzPath}`);
    return { buildCommit, buildCommitShort: buildCommit.slice(0, 7), path: tgzPath };
  });
}

async function withPackageLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  const ownerToken = randomUUID();
  await acquirePackageLock(lockDir, ownerToken);
  try {
    return await fn();
  } finally {
    await releasePackageLock(lockDir, ownerToken);
  }
}

async function acquirePackageLock(
  lockDir: string,
  ownerToken: string,
  params: { writeOwner?: (lockDir: string, ownerToken: string) => Promise<void> } = {},
): Promise<void> {
  const timeoutMs = readPositiveIntEnv("OPENCLAW_PARALLELS_PACKAGE_LOCK_TIMEOUT_MS", 30 * 60_000);
  const staleMs = readPositiveIntEnv("OPENCLAW_PARALLELS_PACKAGE_LOCK_STALE_MS", 2 * 60 * 60_000);
  const startedAt = Date.now();
  let waitAnnouncementBudget = 1;
  const consumeWaitAnnouncement = () => waitAnnouncementBudget-- > 0;
  while (Date.now() - startedAt < timeoutMs) {
    let createdLockDir = false;
    try {
      await mkdir(lockDir);
      createdLockDir = true;
      await (params.writeOwner ?? writeLockOwner)(lockDir, ownerToken);
      return;
    } catch (error) {
      if (createdLockDir) {
        await rm(lockDir, { force: true, recursive: true }).catch(() => undefined);
      }
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await removeStalePackageLock(lockDir, staleMs);
    if (consumeWaitAnnouncement()) {
      say(`Wait for Parallels package lock: ${lockDir}`);
    }
    await delay(1_000);
  }
  throw new Error(`timed out waiting for Parallels package lock: ${lockDir}`);
}

async function writeLockOwner(lockDir: string, ownerToken: string): Promise<void> {
  await writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        token: ownerToken,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function releasePackageLock(lockDir: string, ownerToken: string): Promise<void> {
  const owner = await readLockOwner(lockDir);
  if (owner?.token === ownerToken) {
    await rm(lockDir, { force: true, recursive: true });
  }
}

async function removeStalePackageLock(lockDir: string, staleMs: number): Promise<void> {
  const owner = await readLockOwner(lockDir);
  if (owner?.pid && isProcessAlive(owner.pid)) {
    return;
  }
  const ageMs = Date.now() - ((await stat(lockDir).catch(() => undefined))?.mtimeMs ?? Date.now());
  if (owner?.pid !== undefined || staleMs <= 0 || ageMs >= staleMs) {
    await rm(lockDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function readLockOwner(lockDir: string): Promise<{ pid?: number; token?: string } | null> {
  const text = await readFile(path.join(lockDir, "owner.json"), "utf8").catch(() => "");
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; token?: unknown };
    return {
      pid:
        typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export const testing = {
  acquirePackageLock,
  removeStalePackageLock,
  readLockOwner,
  resolveNpmPackTarballFilename,
};
