#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { runInstalledWorkspaceBootstrapSmoke } from "./lib/workspace-bootstrap-smoke.mjs";
import {
  collectInstalledPackageErrors,
  normalizeInstalledBinaryVersion,
  resolveInstalledBinaryPath,
} from "./openclaw-npm-postpublish-verify.ts";
import { resolveNpmCommandInvocation } from "./openclaw-npm-release-check.ts";

type InstalledPackageJson = {
  version?: string;
};

function npmExec(args: string[], cwd: string): string {
  const invocation = resolveNpmCommandInvocation({
    npmExecPath: process.env.npm_execpath,
    nodeExecPath: process.execPath,
    platform: process.platform,
  });

  return execFileSync(invocation.command, [...invocation.args, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function main(): void {
  const tarballPath = process.argv[2]?.trim();
  const expectedVersion = process.argv[3]?.trim();
  if (!tarballPath) {
    throw new Error(
      "Usage: node --import tsx scripts/openclaw-npm-prepublish-verify.ts <tarball.tgz> [expected-version]",
    );
  }

  const workingDir = mkdtempSync(join(tmpdir(), "openclaw-prepublish-"));
  const prefixDir = join(workingDir, "prefix");
  try {
    npmExec(
      [
        "install",
        "-g",
        "--prefix",
        prefixDir,
        realpathSync(tarballPath),
        "--no-fund",
        "--no-audit",
      ],
      workingDir,
    );
    const globalRoot = npmExec(["root", "-g", "--prefix", prefixDir], workingDir);
    const packageRoot = join(globalRoot, "openclaw");
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as InstalledPackageJson;
    const resolvedExpectedVersion = expectedVersion || pkg.version?.trim() || "";
    const errors = collectInstalledPackageErrors({
      expectedVersion: resolvedExpectedVersion,
      installedVersion: pkg.version?.trim() ?? "",
      packageRoot,
    });
    const installedBinaryVersion = execFileSync(
      resolveInstalledBinaryPath(prefixDir),
      ["--version"],
      {
        cwd: workingDir,
        encoding: "utf8",
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (normalizeInstalledBinaryVersion(installedBinaryVersion) !== resolvedExpectedVersion) {
      errors.push(
        `installed openclaw binary version mismatch: expected ${resolvedExpectedVersion}, found ${installedBinaryVersion || "<missing>"}.`,
      );
    }
    if (errors.length === 0) {
      runInstalledWorkspaceBootstrapSmoke({ packageRoot });
    }
    if (errors.length > 0) {
      throw new Error(`prepared tarball install failed:\n- ${errors.join("\n- ")}`);
    }
    console.log(
      `openclaw-npm-prepublish-verify: prepared tarball install OK (${resolvedExpectedVersion}).`,
    );
  } finally {
    rmSync(workingDir, { force: true, recursive: true });
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint !== null && import.meta.url === entrypoint) {
  try {
    main();
  } catch (error) {
    console.error(`openclaw-npm-prepublish-verify: ${formatErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
