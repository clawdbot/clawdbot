import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNpmPackageLocks } from "../../scripts/generate-npm-package-lock.mts";
import { generateNpmPackageLocksReport } from "../../scripts/npm-package-locks-report.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => `${"a".repeat(40)}\n`),
}));
vi.mock("../../scripts/generate-npm-package-lock.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/generate-npm-package-lock.mts")>()),
  generateNpmPackageLocks: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const dependency = {
  version: "1.0.0",
  resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
  integrity: "sha512-fixture",
};

function sourceFixture() {
  const root = tempDirs.make("openclaw-npm-lock-report-");
  mkdirSync(path.join(root, "extensions"));
  mkdirSync(path.join(root, "packages"));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const writePackage = (dir: string, fields: Record<string, unknown>) => {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(
      path.join(root, dir, "package.json"),
      JSON.stringify({ version: "2026.9.1", ...fields }),
    );
  };
  return { root, writePackage };
}

function fixture() {
  const { root, writePackage } = sourceFixture();
  writePackage(".", { name: "openclaw", dependencies: { fixture: "1.0.0" } });
  // Reverse creation order ensures discovery, not fixture order, owns sorting.
  writePackage("packages/zulu", {
    name: "@openclaw/zulu",
    optionalDependencies: { fixture: "1.0.0" },
    openclaw: { release: { publishToNpm: true, bundleRuntimeDependencies: true } },
  });
  writePackage("extensions/beta", {
    name: "@openclaw/beta",
    dependencies: { fixture: "1.0.0" },
    openclaw: { release: { publishToNpm: true } },
  });
  writePackage("extensions/acpx", {
    name: "@openclaw/acpx",
    dependencies: { fixture: "1.0.0" },
    openclaw: { release: { publishToNpm: true, bundleRuntimeDependencies: false } },
  });
  writePackage("extensions/empty", {
    name: "@openclaw/empty",
    devDependencies: { fixture: "1.0.0" },
    openclaw: { release: { publishToNpm: true } },
  });
  writePackage("extensions/private", {
    name: "@openclaw/private",
    dependencies: { fixture: "1.0.0" },
    openclaw: { release: { publishToNpm: false } },
  });
  return root;
}

function lockFor(packageDir: string) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: manifest.name, version: manifest.version },
      "node_modules/fixture": { ...dependency },
    },
  };
}

describe("npm package-lock release report", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
    vi.mocked(generateNpmPackageLocks).mockImplementation(async ({ packageDirs }) =>
      packageDirs.map((dir) => JSON.stringify(lockFor(dir))),
    );
  });

  it("binds the exact schema, sorted runtime package coverage and hashes to the source root", async () => {
    const rootDir = fixture();
    const report = await generateNpmPackageLocksReport({ rootDir, jobs: 2 });
    expect(report).toEqual({
      schemaVersion: 1,
      generatedAt: expect.any(String),
      generator: "scripts/npm-package-locks-report.mts",
      sourceSha: "a".repeat(40),
      packageVersion: "2026.9.1",
      pnpmLockSha256: hash("lockfileVersion: '9.0'\n"),
      lockfileVersion: 3,
      packagesWithOmittedWorkspaceDependencies: 0,
      packages: [
        [".", "openclaw", false, 1, 0],
        ["extensions/acpx", "@openclaw/acpx", false, 1, 0],
        ["extensions/beta", "@openclaw/beta", true, 1, 0],
        ["packages/zulu", "@openclaw/zulu", true, 0, 1],
      ].map(
        ([
          packageDir,
          name,
          bundleRuntimeDependencies,
          dependencyCount,
          optionalDependencyCount,
        ]) => {
          const lock = lockFor(path.join(rootDir, String(packageDir)));
          return {
            packageDir,
            name,
            version: "2026.9.1",
            bundleRuntimeDependencies,
            dependencyCount,
            optionalDependencyCount,
            omittedWorkspaceDependencies: [],
            lockSha256: hash(`${JSON.stringify(lock, null, 2)}\n`),
            lock,
          };
        },
      ),
    });
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    expect(execFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    expect(generateNpmPackageLocks).toHaveBeenCalledWith({
      rootDir,
      jobs: 2,
      packageDirs: report.packages.map((entry) => path.join(rootDir, entry.packageDir)),
    });
    const second = await generateNpmPackageLocksReport({ rootDir, jobs: 1 });
    expect({ ...second, generatedAt: report.generatedAt }).toEqual(report);
  });

  it("marks only the root and gateway client partial in the release-split fixture", async () => {
    const { root, writePackage } = sourceFixture();
    writePackage(".", {
      name: "openclaw",
      dependencies: { "@openclaw/ai": "workspace:*", fixture: "1.0.0" },
    });
    writePackage("packages/gateway-client", {
      name: "@openclaw/gateway-client",
      dependencies: { "@openclaw/gateway-protocol": "workspace:*", fixture: "1.0.0" },
      openclaw: { release: { publishToNpm: true } },
    });
    const locklessPlugins = [
      "acpx",
      "codex",
      "copilot",
      "memory-lancedb",
      "msteams",
      "tlon",
      "twitch",
    ];
    for (const plugin of locklessPlugins) {
      writePackage(`extensions/${plugin}`, {
        name: `@openclaw/${plugin}`,
        dependencies: { fixture: "1.0.0" },
        devDependencies: { "@openclaw/plugin-sdk": "workspace:*" },
        openclaw: { release: { publishToNpm: true, bundleRuntimeDependencies: false } },
      });
    }
    const report = await generateNpmPackageLocksReport({ rootDir: root });
    expect(report.packageVersion).toBe("2026.9.1");
    expect(report.packagesWithOmittedWorkspaceDependencies).toBe(2);
    expect(
      report.packages
        .filter((entry) => entry.omittedWorkspaceDependencies.length > 0)
        .map((entry) => ({
          name: entry.name,
          omittedWorkspaceDependencies: entry.omittedWorkspaceDependencies,
        })),
    ).toEqual([
      { name: "openclaw", omittedWorkspaceDependencies: ["@openclaw/ai"] },
      {
        name: "@openclaw/gateway-client",
        omittedWorkspaceDependencies: ["@openclaw/gateway-protocol"],
      },
    ]);
    expect(
      report.packages
        .filter((entry) => entry.packageDir !== "." && !entry.bundleRuntimeDependencies)
        .map((entry) => ({
          name: entry.name,
          omittedWorkspaceDependencies: entry.omittedWorkspaceDependencies,
        })),
    ).toEqual(
      locklessPlugins.map((plugin) => ({
        name: `@openclaw/${plugin}`,
        omittedWorkspaceDependencies: [],
      })),
    );
  });

  it("sorts and deduplicates runtime omissions without including dev or peer references", async () => {
    const { root, writePackage } = sourceFixture();
    writePackage(".", {
      name: "openclaw",
      dependencies: { zeta: "workspace:*", alpha: "workspace:^", fixture: "1.0.0" },
      optionalDependencies: { middle: "workspace:~", alpha: "workspace:^" },
      devDependencies: { development: "workspace:*" },
      peerDependencies: { peer: "workspace:*" },
    });
    const report = await generateNpmPackageLocksReport({ rootDir: root });
    expect(report.packagesWithOmittedWorkspaceDependencies).toBe(1);
    expect(report.packages[0]!.omittedWorkspaceDependencies).toEqual(["alpha", "middle", "zeta"]);
  });

  it("rejects an omission claim when the generated lock resolves that workspace package", async () => {
    const { root, writePackage } = sourceFixture();
    writePackage(".", { name: "openclaw", dependencies: { "@openclaw/ai": "workspace:*" } });
    vi.mocked(generateNpmPackageLocks).mockImplementation(async ({ packageDirs }) =>
      packageDirs.map((dir) => {
        const lock = lockFor(dir);
        Object.assign(lock.packages, { "node_modules/@openclaw/ai": dependency });
        return JSON.stringify(lock);
      }),
    );
    await expect(generateNpmPackageLocksReport({ rootDir: root })).rejects.toThrow(
      ".: npm lock contains omitted workspace dependency @openclaw/ai",
    );
  });

  it.each([
    { dev: true },
    { link: true },
    ...[
      "file:local.tgz",
      "workspace:*",
      "git+https://example.com/repo",
      "git:repo",
      "ssh:repo",
      "https://github.com/org/repo",
    ].map((resolved) => ({ resolved })),
    { resolved: "" },
    { resolved: undefined },
    { integrity: "" },
    { integrity: undefined },
  ])("rejects nonportable or incomplete lock entries: %j", async (invalid) => {
    vi.mocked(generateNpmPackageLocks).mockImplementation(async ({ packageDirs }) =>
      packageDirs.map((dir) => {
        const lock = lockFor(dir);
        Object.assign(lock.packages["node_modules/fixture"], invalid);
        return JSON.stringify(lock);
      }),
    );
    await expect(generateNpmPackageLocksReport({ rootDir: fixture() })).rejects.toThrow(
      ".: unsupported npm lock entry node_modules/fixture",
    );
  });

  it.each(["name", "version", "lockfileVersion", "rootName", "rootVersion", "rootDev"])(
    "rejects mismatched lock identity or root metadata: %s",
    async (field) => {
      vi.mocked(generateNpmPackageLocks).mockImplementation(async ({ packageDirs }) =>
        packageDirs.map((dir) => {
          const lock = lockFor(dir);
          if (field === "rootName") {
            lock.packages[""].name = "wrong";
          } else if (field === "rootVersion") {
            lock.packages[""].version = "wrong";
          } else if (field === "rootDev") {
            Object.assign(lock.packages[""], { dev: true });
          } else {
            Object.assign(lock, { [field]: "wrong" });
          }
          return JSON.stringify(lock);
        }),
      );
      await expect(generateNpmPackageLocksReport({ rootDir: fixture() })).rejects.toThrow(/\.:/u);
    },
  );
});
