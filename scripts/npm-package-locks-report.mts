#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  generateNpmPackageLocks,
  listManagedNpmLockPackageDirs,
  resolveNpmLockJobs,
} from "./generate-npm-package-lock.mts";
import { parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import { isRecord } from "./lib/record-shared.mjs";
import { REPORT_CLI_PARSE_OPTIONS, writeReportArtifact } from "./lib/report-cli-helpers.mts";

function sha256(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPackage(rootDir: string, packageDir: string) {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(rootDir, packageDir, "package.json"), "utf8"),
  );
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== "string" ||
    !manifest.name ||
    typeof manifest.version !== "string" ||
    !manifest.version
  ) {
    throw new Error(`${packageDir}: expected package name and version`);
  }
  const release = isRecord(manifest.openclaw) ? manifest.openclaw.release : undefined;
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {};
  const optionalDependencies = isRecord(manifest.optionalDependencies)
    ? manifest.optionalDependencies
    : {};
  const omittedWorkspaceDependencies = [
    ...new Set(
      [...Object.entries(dependencies), ...Object.entries(optionalDependencies)]
        .filter(([, spec]) => typeof spec === "string" && spec.startsWith("workspace:"))
        .map(([name]) => name),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  return {
    packageDir,
    name: manifest.name,
    version: manifest.version,
    bundleRuntimeDependencies:
      packageDir !== "." && !(isRecord(release) && release.bundleRuntimeDependencies === false),
    dependencyCount: Object.keys(dependencies).length,
    optionalDependencyCount: Object.keys(optionalDependencies).length,
    omittedWorkspaceDependencies,
  };
}

function validateLock(text: string, entry: Awaited<ReturnType<typeof readPackage>>) {
  const lock: unknown = JSON.parse(text);
  if (
    !isRecord(lock) ||
    lock.lockfileVersion !== 3 ||
    lock.name !== entry.name ||
    lock.version !== entry.version ||
    !isRecord(lock.packages)
  ) {
    throw new Error(
      `${entry.packageDir}: expected a version 3 npm lock for ${entry.name}@${entry.version}`,
    );
  }
  const root = lock.packages[""];
  if (!isRecord(root) || root.name !== entry.name || root.version !== entry.version) {
    throw new Error(`${entry.packageDir}: npm lock root identity mismatch`);
  }
  for (const name of entry.omittedWorkspaceDependencies) {
    if (Object.hasOwn(lock.packages, `node_modules/${name}`)) {
      throw new Error(
        `${entry.packageDir}: npm lock contains omitted workspace dependency ${name}`,
      );
    }
  }
  for (const [lockPath, metadata] of Object.entries(lock.packages)) {
    if (
      !isRecord(metadata) ||
      metadata.dev === true ||
      metadata.link === true ||
      (typeof metadata.resolved === "string" &&
        /^(?:file:|workspace:|git\+|git:|ssh:|https:\/\/github\.com\/)/iu.test(
          metadata.resolved,
        )) ||
      (lockPath !== "" &&
        (typeof metadata.resolved !== "string" ||
          !metadata.resolved ||
          typeof metadata.integrity !== "string" ||
          !metadata.integrity))
    ) {
      throw new Error(`${entry.packageDir}: unsupported npm lock entry ${lockPath || "<root>"}`);
    }
  }
  return lock;
}

export async function generateNpmPackageLocksReport({
  rootDir: sourceRoot = process.cwd(),
  jobs = resolveNpmLockJobs(undefined),
}: { rootDir?: string; jobs?: number } = {}) {
  const rootDir = path.resolve(sourceRoot);
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw new Error("Expected the source root's full Git commit SHA");
  }
  const pnpmLockSha256 = sha256(await readFile(path.join(rootDir, "pnpm-lock.yaml")));
  const manifests = await Promise.all(
    [".", ...listManagedNpmLockPackageDirs(rootDir)].map((dir) => readPackage(rootDir, dir)),
  );
  const entries = manifests.filter(
    (entry) =>
      entry.packageDir === "." || entry.dependencyCount + entry.optionalDependencyCount > 0,
  );
  const locks = await generateNpmPackageLocks({
    rootDir,
    jobs: resolveNpmLockJobs(jobs),
    packageDirs: entries.map((entry) => path.join(rootDir, entry.packageDir)),
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generator: "scripts/npm-package-locks-report.mts",
    sourceSha,
    packageVersion: manifests[0]!.version,
    pnpmLockSha256,
    lockfileVersion: 3,
    packagesWithOmittedWorkspaceDependencies: entries.filter(
      (entry) => entry.omittedWorkspaceDependencies.length > 0,
    ).length,
    packages: entries.map((entry, index) => {
      const lock = validateLock(locks[index]!, entry);
      return Object.assign(entry, {
        lockSha256: sha256(`${JSON.stringify(lock, null, 2)}\n`),
        lock,
      });
    }),
  };
}

type NpmPackageLocksReport = Awaited<ReturnType<typeof generateNpmPackageLocksReport>>;

function renderMarkdown(report: NpmPackageLocksReport) {
  return `${[
    "# npm package-lock mirrors",
    "",
    `Source: \`${report.sourceSha}\` (OpenClaw ${report.packageVersion}).`,
    `pnpm lock SHA-256: \`${report.pnpmLockSha256}\`.`,
    "",
    `Total packages: ${report.packages.length}`,
    `Lockless packages (bundleRuntimeDependencies=false): ${report.packages.filter((entry) => !entry.bundleRuntimeDependencies).length}`,
    `Partial locks (omitted workspace dependencies): ${report.packagesWithOmittedWorkspaceDependencies}`,
    "",
    "Entries with non-empty omittedWorkspaceDependencies are partial locks: sibling workspace packages publish in the same release and are omitted by the generator. Consumers must reject these entries instead of installing them.",
    "Select the exact name and version in npm-package-locks.json, require an empty omittedWorkspaceDependencies array, and write entry.lock as package-lock.json.",
    "Verify dependency-evidence-manifest.json releaseSha equals sourceSha and the OpenClaw commit you pin.",
    "These generated locks are release evidence only and are never included in npm tarballs.",
    "",
    "| Package directory | Name | Version | Bundles runtime dependencies | Dependencies | Optional dependencies | Omitted workspace dependencies |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.packages.map(
      (entry) =>
        `| ${entry.packageDir} | ${entry.name} | ${entry.version} | ${entry.bundleRuntimeDependencies} | ${entry.dependencyCount} | ${entry.optionalDependencyCount} | ${entry.omittedWorkspaceDependencies.length > 0 ? `Partial: ${entry.omittedWorkspaceDependencies.join(", ")}` : "None"} |`,
    ),
  ].join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const options: {
    rootDir: string;
    jsonPath: string | null;
    markdownPath: string | null;
    jobs: string | null;
  } = { rootDir: process.cwd(), jsonPath: null, markdownPath: null, jobs: null };
  const flags = [
    ["--root", "rootDir"],
    ["--json", "jsonPath"],
    ["--markdown", "markdownPath"],
    ["--jobs", "jobs"],
  ] satisfies Array<[string, keyof typeof options]>;
  const parsed = parseFlagArgs(
    argv,
    options,
    flags.map(([flag, key]) =>
      stringFlag(flag, key, { allowInline: false, rejectShortOptions: true }),
    ),
    REPORT_CLI_PARSE_OPTIONS,
  );
  const report = await generateNpmPackageLocksReport({
    rootDir: parsed.rootDir,
    jobs: resolveNpmLockJobs(parsed.jobs),
  });
  const markdown = renderMarkdown(report);
  await writeReportArtifact(parsed.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeReportArtifact(parsed.markdownPath, markdown);
  process.stdout.write(markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
