import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

export async function ensureCurrentBuild(input: {
  lockDir: string;
  requireControlUi?: boolean;
  checkDirty?: boolean;
}): Promise<void> {
  await withPackageLock(input.lockDir, async () => ensureCurrentBuildUnlocked(input));
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
  const drift = run("git", ["status", "--porcelain", "--", "src/canvas-host/a2ui/.bundle.hash"], {
    quiet: true,
  }).stdout.trim();
  if (drift) {
    die(`generated file drift after build; commit or revert before Parallels packaging:\n${drift}`);
  }
}

export async function packOpenClaw(input: {
  destination: string;
  packageSpec?: string;
  requireControlUi?: boolean;
  stageRuntimeDeps?: boolean;
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
    const packed = JSON.parse(output).at(-1)?.filename as string | undefined;
    if (!packed) {
      die("npm pack did not report a filename");
    }
    const tgzPath = path.join(input.destination, path.basename(packed));
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
    run("node", [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      "import { writePackageDistInventory } from './src/infra/package-dist-inventory.ts'; await writePackageDistInventory(process.cwd());",
    ]);
    if (input.stageRuntimeDeps) {
      run("node", ["scripts/stage-bundled-plugin-runtime-deps.mjs"]);
    }
    const shortHead = run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim();
    const output = run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", input.destination],
      {
        quiet: true,
      },
    ).stdout;
    const packed = JSON.parse(output).at(-1)?.filename as string | undefined;
    if (!packed) {
      die("npm pack did not report a filename");
    }
    const tgzPath = path.join(input.destination, `openclaw-main-${shortHead}.tgz`);
    await copyFile(path.join(input.destination, packed), tgzPath);
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

async function acquirePackageLock(lockDir: string, ownerToken: string): Promise<void> {
  const timeoutMs = Number(process.env.OPENCLAW_PARALLELS_PACKAGE_LOCK_TIMEOUT_MS || 30 * 60_000);
  const staleMs = Number(process.env.OPENCLAW_PARALLELS_PACKAGE_LOCK_STALE_MS || 2 * 60 * 60_000);
  const startedAt = Date.now();
  let announcedWait = false;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await mkdir(lockDir);
      await writeLockOwner(lockDir, ownerToken);
      return;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await removeStalePackageLock(lockDir, staleMs);
    if (!announcedWait) {
      say(`Wait for Parallels package lock: ${lockDir}`);
      announcedWait = true;
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
  if (owner || ageMs >= staleMs) {
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
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
