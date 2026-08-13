// Exercises packaged launcher version provenance without loading the runtime.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

const packageVersion = "1.2.3-test";
const checkoutCommit = "abcdef0123456789abcdef0123456789abcdef01";
const buildCommit = "1234567890abcdef1234567890abcdef12345678";

type LauncherVersionFixtureOptions = {
  buildCommit?: string;
  checkout?: "directory" | "linked";
  packageCommit?: string;
};

async function makeLauncherVersionFixture(
  fixtureRoots: string[],
  options: LauncherVersionFixtureOptions = {},
): Promise<string> {
  const fixtureRoot = makeTempDir(fixtureRoots, "openclaw-launcher-version-");
  await fs.copyFile(
    path.resolve(process.cwd(), "openclaw.mjs"),
    path.join(fixtureRoot, "openclaw.mjs"),
  );
  await fs.mkdir(path.join(fixtureRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: packageVersion,
      ...(options.packageCommit ? { gitHead: options.packageCommit } : {}),
    }),
  );
  await fs.writeFile(
    path.join(fixtureRoot, "dist", "entry.js"),
    "throw new Error('version fast path must not load the runtime entry');\n",
  );

  if (options.buildCommit) {
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "build-info.json"),
      JSON.stringify({ version: packageVersion, commit: options.buildCommit }),
    );
  }

  if (options.checkout) {
    const gitDirectory =
      options.checkout === "linked"
        ? path.join(fixtureRoot, "worktree-git")
        : path.join(fixtureRoot, ".git");
    await fs.mkdir(gitDirectory, { recursive: true });
    await fs.writeFile(path.join(gitDirectory, "HEAD"), `${checkoutCommit}\n`);
    if (options.checkout === "linked") {
      await fs.writeFile(path.join(fixtureRoot, ".git"), "gitdir: worktree-git\n");
    }
  }

  return fixtureRoot;
}

function runLauncherVersion(
  fixtureRoot: string,
  options: { flag?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(
    process.execPath,
    [path.join(fixtureRoot, "openclaw.mjs"), options.flag ?? "--version"],
    {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        GIT_COMMIT: undefined,
        GIT_SHA: undefined,
        OPENCLAW_CONTAINER: undefined,
        ...options.env,
      },
      encoding: "utf8",
    },
  );
}

describe("openclaw launcher version provenance", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    cleanupTempDirs(fixtureRoots);
  });

  it.each(["directory", "linked"] as const)(
    "reports the packaged build rather than the current %s checkout",
    async (checkout) => {
      const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, {
        buildCommit,
        checkout,
      });

      const result = runLauncherVersion(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`OpenClaw ${packageVersion} (${buildCommit.slice(0, 7)})\n`);
      expect(result.stderr).toBe("");
    },
  );

  it.each(["directory", "linked"] as const)(
    "reports the live %s checkout when no packaged build metadata exists",
    async (checkout) => {
      const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, { checkout });

      const result = runLauncherVersion(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`OpenClaw ${packageVersion} (${checkoutCommit.slice(0, 7)})\n`);
      expect(result.stderr).toBe("");
    },
  );

  it.each(["--version", "-V", "-v"])(
    "reports the packaged build for the %s fast path without importing the runtime",
    async (flag) => {
      const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, { buildCommit });

      const result = runLauncherVersion(fixtureRoot, { flag });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`OpenClaw ${packageVersion} (${buildCommit.slice(0, 7)})\n`);
      expect(result.stderr).toBe("");
    },
  );

  it.each([
    {
      name: "explicit GIT_COMMIT",
      env: { GIT_COMMIT: "fedcba9876543210fedcba9876543210fedcba98" },
      expected: "fedcba9",
    },
    {
      name: "explicit GIT_SHA",
      env: { GIT_SHA: "deadc0de0123456789abcdef0123456789abcdef" },
      expected: "deadc0d",
    },
    {
      name: "GIT_COMMIT precedence over GIT_SHA",
      env: {
        GIT_COMMIT: "fedcba9876543210fedcba9876543210fedcba98",
        GIT_SHA: "deadc0de0123456789abcdef0123456789abcdef",
      },
      expected: "fedcba9",
    },
  ])("preserves $name over packaged and checkout metadata", async ({ env, expected }) => {
    const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, {
      buildCommit,
      checkout: "linked",
    });

    const result = runLauncherVersion(fixtureRoot, { env });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`OpenClaw ${packageVersion} (${expected})\n`);
    expect(result.stderr).toBe("");
  });

  it("uses package metadata when neither a build nor a checkout commit is available", async () => {
    const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, {
      packageCommit: checkoutCommit,
    });

    const result = runLauncherVersion(fixtureRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`OpenClaw ${packageVersion} (${checkoutCommit.slice(0, 7)})\n`);
    expect(result.stderr).toBe("");
  });

  it("defers container-targeted root version to the runtime entry", async () => {
    const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, { buildCommit });
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
    );

    const argumentResult = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "--container", "demo", "--version"],
      {
        cwd: fixtureRoot,
        env: { ...process.env, OPENCLAW_CONTAINER: undefined },
        encoding: "utf8",
      },
    );

    expect(argumentResult.status).toBe(0);
    expect(argumentResult.stdout).toBe("RUNTIME ENTRY\n");

    const environmentResult = runLauncherVersion(fixtureRoot, {
      env: { OPENCLAW_CONTAINER: "demo" },
    });

    expect(environmentResult.status).toBe(0);
    expect(environmentResult.stdout).toBe("RUNTIME ENTRY\n");
  });
});
