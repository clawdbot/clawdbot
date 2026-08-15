// ClawHub release policy tests execute the real npm and ClawHub release checks.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../../../helpers/temp-repo.js";

const CLAWHUB_CHECK = resolve("scripts/plugin-clawhub-release-check.ts");
const NPM_CHECK = resolve("scripts/plugin-npm-release-check.ts");
const REPOSITORY_URL = "https://github.com/openclaw/openclaw";
const PACKAGE_NAME = "@openclaw/demo-plugin";
const INITIAL_VERSION = "2026.8.3";
const tsxImport = import.meta.resolve("tsx");
const tempDirs: string[] = [];

type FixtureOptions = {
  includeBuildVersion?: boolean;
  includePluginApi?: boolean;
  repositoryUrl?: string;
  version?: string;
};

afterEach(() => cleanupTempDirs(tempDirs));

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function packageManifest(options: FixtureOptions = {}) {
  const version = options.version ?? INITIAL_VERSION;
  return {
    name: PACKAGE_NAME,
    version,
    type: "module",
    repository: {
      type: "git",
      url: options.repositoryUrl ?? REPOSITORY_URL,
    },
    openclaw: {
      extensions: ["./index.ts"],
      ...(options.includePluginApi === false
        ? {}
        : {
            compat: {
              pluginApi: `>=${version}`,
            },
          }),
      ...(options.includeBuildVersion === false
        ? {}
        : {
            build: {
              openclawVersion: version,
            },
          }),
      install: {
        npmSpec: PACKAGE_NAME,
      },
      release: {
        publishToClawHub: true,
        publishToNpm: true,
      },
    },
  };
}

function createPluginRepo(options: FixtureOptions = {}) {
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-clawhub-policy-");
  const packageDir = join(repoDir, "extensions", "demo-plugin");
  mkdirSync(packageDir, { recursive: true });
  writeJsonFile(join(repoDir, "package.json"), {
    name: "openclaw-release-policy-fixture",
    private: true,
  });
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeJsonFile(join(packageDir, "package.json"), packageManifest(options));
  writeFileSync(join(packageDir, "index.ts"), "export const demo = 1;\n", "utf8");
  writeFileSync(join(packageDir, "README.md"), "# Demo plugin\n", "utf8");

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial plugin",
  ]);
  return repoDir;
}

function commitFixture(repoDir: string, message: string) {
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function runCheck(scriptPath: string, cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, ["--import", tsxImport, scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
}

function expectValidPackage(result: ReturnType<typeof runCheck>, command: string, version: string) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`${command}: publishable plugin metadata looks OK.`);
  expect(result.stdout).toContain(`- ${PACKAGE_NAME}@${version} (stable, demo-plugin)`);
}

describe("ClawHub release policy contracts", () => {
  it("validates package identity, version, and extension metadata through both release checks", () => {
    const repoDir = createPluginRepo();

    expectValidPackage(
      runCheck(CLAWHUB_CHECK, repoDir),
      "plugin-clawhub-release-check",
      INITIAL_VERSION,
    );
    expectValidPackage(runCheck(NPM_CHECK, repoDir), "plugin-npm-release-check", INITIAL_VERSION);
  });

  it("requires the canonical repository provenance for ClawHub and npm publishing", () => {
    const repoDir = createPluginRepo({
      repositoryUrl: "https://example.invalid/not-openclaw",
    });
    const expected = `package.json repository.url must be "${REPOSITORY_URL}" so npm provenance can validate GitHub trusted publishing`;

    for (const scriptPath of [CLAWHUB_CHECK, NPM_CHECK]) {
      const result = runCheck(scriptPath, repoDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(expected);
    }
  });

  it("requires the external code plugin compatibility and build contract", () => {
    const repoDir = createPluginRepo({
      includeBuildVersion: false,
      includePluginApi: false,
    });

    for (const scriptPath of [CLAWHUB_CHECK, NPM_CHECK]) {
      const result = runCheck(scriptPath, repoDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "openclaw.compat.pluginApi is required for external code plugin packages.",
      );
      expect(result.stderr).toContain(
        "openclaw.build.openclawVersion is required for external code plugin packages.",
      );
    }
  });

  it("rejects a changed publishable plugin whose committed version did not change", () => {
    const repoDir = createPluginRepo();
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);
    writeFileSync(
      join(repoDir, "extensions", "demo-plugin", "index.ts"),
      "export const demo = 2;\n",
      "utf8",
    );
    const headRef = commitFixture(repoDir, "change plugin source");

    const result = runCheck(CLAWHUB_CHECK, repoDir, ["--base-ref", baseRef, "--head-ref", headRef]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("version bumps required before ClawHub publish");
    expect(result.stderr).toContain(
      `${PACKAGE_NAME}@${INITIAL_VERSION}: changed publishable plugin still has the same version in package.json.`,
    );
  });

  it("accepts a source change with a committed package version bump", () => {
    const repoDir = createPluginRepo();
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);
    const nextVersion = "2026.8.4";
    writeFileSync(
      join(repoDir, "extensions", "demo-plugin", "index.ts"),
      "export const demo = 2;\n",
      "utf8",
    );
    const manifestPath = join(repoDir, "extensions", "demo-plugin", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReturnType<
      typeof packageManifest
    >;
    writeJsonFile(manifestPath, {
      ...manifest,
      version: nextVersion,
      openclaw: {
        ...manifest.openclaw,
        compat: {
          pluginApi: `>=${nextVersion}`,
        },
        build: {
          openclawVersion: nextVersion,
        },
      },
    });
    const headRef = commitFixture(repoDir, "bump plugin version");
    const args = ["--base-ref", baseRef, "--head-ref", headRef];

    expectValidPackage(
      runCheck(CLAWHUB_CHECK, repoDir, args),
      "plugin-clawhub-release-check",
      nextVersion,
    );
    expectValidPackage(runCheck(NPM_CHECK, repoDir, args), "plugin-npm-release-check", nextVersion);
  });
});
