#!/usr/bin/env -S node --import tsx
// Openclaw Npm Prepublish Verify script supports OpenClaw repository automation.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { type NpmVerifyCommandInvocation, runNpmVerifyCommand } from "./lib/npm-verify-exec.ts";
import { runInstalledWorkspaceBootstrapSmoke } from "./lib/workspace-bootstrap-smoke.mjs";
import {
  collectInstalledPackageErrors,
  normalizeInstalledBinaryVersion,
  resolveInstalledBinaryCommandInvocation,
} from "./openclaw-npm-postpublish-verify.ts";
import { resolveNpmCommandInvocation } from "./openclaw-npm-release-check.ts";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

type InstalledPackageJson = {
  version?: string;
};

type OpenClawNpmPrepublishVerifyArgs =
  | {
      expectedVersion?: string;
      dependencyTarballPaths: string[];
      help: false;
      tarballPath: string;
    }
  | {
      expectedVersion?: undefined;
      dependencyTarballPaths: [];
      help: true;
      tarballPath: "";
    };

export function openClawNpmPrepublishVerifyUsage(): string {
  return "Usage: node --import tsx scripts/openclaw-npm-prepublish-verify.ts <tarball.tgz> [expected-version] [dependency.tgz ...]";
}

export function parseOpenClawNpmPrepublishVerifyArgs(
  argv: readonly string[],
): OpenClawNpmPrepublishVerifyArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const tarballPath = args[0]?.trim() ?? "";
  if (tarballPath === "--help" || tarballPath === "-h") {
    return { dependencyTarballPaths: [], help: true, tarballPath: "" };
  }
  if (!tarballPath) {
    throw new Error(openClawNpmPrepublishVerifyUsage());
  }
  if (tarballPath.startsWith("-")) {
    throw new Error(`Unknown openclaw npm prepublish verifier option: ${tarballPath}`);
  }

  const expectedVersion = args[1]?.trim();
  if (expectedVersion?.startsWith("-")) {
    throw new Error(`Unknown openclaw npm prepublish verifier option: ${expectedVersion}`);
  }
  const dependencyTarballPaths = args.slice(2).map((value) => value.trim());
  const invalidDependency = dependencyTarballPaths.find(
    (value) => value.length === 0 || value.startsWith("-"),
  );
  if (invalidDependency !== undefined) {
    throw new Error(`Invalid dependency tarball path: ${invalidDependency || "<empty>"}`);
  }

  return expectedVersion
    ? { dependencyTarballPaths, expectedVersion, help: false, tarballPath }
    : { dependencyTarballPaths, help: false, tarballPath };
}

export function usesPreparedLocalDependencyInstall(dependencyTarballCount: number): boolean {
  return dependencyTarballCount === 1;
}

function npmExec(args: string[], cwd: string): string {
  const invocation = resolveNpmCommandInvocation({
    npmArgs: args,
    npmExecPath: process.env.npm_execpath,
    nodeExecPath: process.execPath,
    platform: process.platform,
  });

  return runNpmVerifyCommand(invocation, cwd);
}

function main(argv = process.argv.slice(2)): void {
  const args = parseOpenClawNpmPrepublishVerifyArgs(argv);
  if (args.help) {
    console.log(openClawNpmPrepublishVerifyUsage());
    return;
  }

  const workingDir = mkdtempSync(join(tmpdir(), "openclaw-prepublish-"));
  const prefixDir = join(workingDir, "prefix");
  try {
    let binaryInvocation: NpmVerifyCommandInvocation;
    let packageRoot: string;
    if (usesPreparedLocalDependencyInstall(args.dependencyTarballPaths.length)) {
      mkdirSync(prefixDir, { recursive: true });
      writeFileSync(
        join(prefixDir, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            dependencies: {
              "@openclaw/ai": pathToFileURL(
                realpathSync(
                  expectDefined(args.dependencyTarballPaths[0], "prepared dependency tarball"),
                ),
              ).href,
              openclaw: pathToFileURL(realpathSync(args.tarballPath)).href,
            },
          },
          null,
          2,
        )}\n`,
      );
      npmExec(["install", "--prefix", prefixDir, "--no-fund", "--no-audit"], workingDir);
      packageRoot = join(prefixDir, "node_modules", "openclaw");
      const binaryPath = join(
        prefixDir,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "openclaw.cmd" : "openclaw",
      );
      binaryInvocation =
        process.platform === "win32"
          ? {
              command: resolveWindowsCmdExePath(),
              args: ["/d", "/s", "/c", buildCmdExeCommandLine(binaryPath, ["--version"])],
              windowsVerbatimArguments: true,
            }
          : { command: binaryPath, args: ["--version"] };
    } else {
      npmExec(
        [
          "install",
          "-g",
          "--prefix",
          prefixDir,
          ...args.dependencyTarballPaths.map((dependency) => realpathSync(dependency)),
          realpathSync(args.tarballPath),
          "--no-fund",
          "--no-audit",
        ],
        workingDir,
      );
      const globalRoot = npmExec(["root", "-g", "--prefix", prefixDir], workingDir);
      packageRoot = join(globalRoot, "openclaw");
      binaryInvocation = resolveInstalledBinaryCommandInvocation(prefixDir, ["--version"]);
    }
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as InstalledPackageJson;
    const resolvedExpectedVersion = args.expectedVersion || pkg.version?.trim() || "";
    const errors = collectInstalledPackageErrors({
      expectedVersion: resolvedExpectedVersion,
      installedVersion: pkg.version?.trim() ?? "",
      packageRoot,
    });
    const installedBinaryVersion = runNpmVerifyCommand(binaryInvocation, workingDir);
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
