// Generate Npm Shrinkwrap tests cover generate npm shrinkwrap script behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPackageExtensionPeerMetadata,
  collectCurrentShrinkwrapOverrides,
  collectOverrideViolations,
  collectPnpmLockViolations,
  createNpmShrinkwrapExecOptions,
  createNpmShrinkwrapCommand,
  disableShrinkwrappedOverrideConflictSources,
  exactOverrideRulesFromOverrides,
  exactVersionFromOverrideSpec,
  normalizeNpmVersionDrift,
  normalizeOverrides,
  packageJsonForShrinkwrap,
  packageDependencyInputsChanged,
  pnpmLockOverrideVersionForVersions,
  parsePnpmPackageKey,
  parseLockPackagePath,
  resolvePackageDirs,
  resolveShrinkwrapJobs,
  restoreCurrentPnpmLockedPackages,
  shouldUseLegacyPeerDepsForShrinkwrap,
  shrinkwrapPackageDirsForChangedPaths,
} from "../../scripts/generate-npm-shrinkwrap.mjs";

describe("generate-npm-shrinkwrap", () => {
  function repoRelativePath(value: string): string {
    return path.relative(process.cwd(), value).replaceAll("\\", "/");
  }

  it("omits workspace packages that are published beside the package", () => {
    const normalized = packageJsonForShrinkwrap(
      {
        dependencies: { "@openclaw/ai": "workspace:2026.6.11", chalk: "5.6.2" },
        devDependencies: { local: "workspace:*" },
        peerDependencies: { host: "workspace:^1.2.3" },
      },
      {},
    );

    expect(normalized).not.toHaveProperty("devDependencies");
    expect(normalized.dependencies).toEqual({ chalk: "5.6.2" });
    expect(normalized.peerDependencies).toEqual({});
  });

  it("runs npm shrinkwrap through cmd.exe for Windows npm shims", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    expect(
      createNpmShrinkwrapCommand(["shrinkwrap", "--ignore-scripts"], {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        execPath,
        existsSync: (candidate: string) => candidate === npmCmdPath,
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", `${npmCmdPath} shrinkwrap --ignore-scripts`],
      command: "C:\\Windows\\System32\\cmd.exe",
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("bounds npm shrinkwrap command runtime and captured output by default", () => {
    expect(
      createNpmShrinkwrapExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {}),
    ).toMatchObject({
      cwd: "/tmp/package",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10 * 60 * 1000,
    });
  });

  it("normalizes pnpm scoped override selectors for npm shrinkwrap", () => {
    expect(
      normalizeOverrides({
        "openclaw@2026.5.28>undici": "8.5.0",
        tar: 7.5,
      }),
    ).toEqual({
      "openclaw@2026.5.28": {
        undici: "8.5.0",
      },
      tar: "7.5",
    });
  });

  it("rejects short flag package selectors before resolving shrinkwrap targets", () => {
    expect(() => resolvePackageDirs(["--package-dir", "-h"])).toThrow(
      "--package-dir requires a package directory.",
    );
    expect(() => resolvePackageDirs(["--changed", "--base", "-h"])).toThrow(
      "--base requires a git ref.",
    );
    expect(() => resolvePackageDirs(["--changed", "--head", "-h"])).toThrow(
      "--head requires a git ref.",
    );
    expect(() => resolvePackageDirs(["--jobs", "-h"])).toThrow(
      "--jobs requires a positive integer.",
    );
  });

  it("validates shrinkwrap worker counts from flags and environment", () => {
    expect(resolveShrinkwrapJobs("3", {})).toBe(3);
    expect(resolveShrinkwrapJobs(undefined, { OPENCLAW_NPM_SHRINKWRAP_JOBS: "2" })).toBe(2);
    expect(() => resolveShrinkwrapJobs("0", {})).toThrow("invalid OPENCLAW_NPM_SHRINKWRAP_JOBS: 0");
    expect(() => resolveShrinkwrapJobs("17", {})).toThrow("maximum is 16");
  });

  it("accepts strict npm shrinkwrap command timeout and buffer overrides", () => {
    expect(
      createNpmShrinkwrapExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_SHRINKWRAP_COMMAND_MAX_BUFFER_BYTES: "1048576",
        OPENCLAW_NPM_SHRINKWRAP_COMMAND_TIMEOUT_MS: "30000",
      }),
    ).toMatchObject({
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    });
  });

  it("rejects loose npm shrinkwrap command timeout and buffer overrides", () => {
    expect(() =>
      createNpmShrinkwrapExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_SHRINKWRAP_COMMAND_TIMEOUT_MS: "30s",
      }),
    ).toThrow("invalid OPENCLAW_NPM_SHRINKWRAP_COMMAND_TIMEOUT_MS: 30s");
    expect(() =>
      createNpmShrinkwrapExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_SHRINKWRAP_COMMAND_MAX_BUFFER_BYTES: "64mb",
      }),
    ).toThrow("invalid OPENCLAW_NPM_SHRINKWRAP_COMMAND_MAX_BUFFER_BYTES: 64mb");
  });

  it("extracts exact versions from npm override specs", () => {
    expect(exactVersionFromOverrideSpec("8.4.0")).toBe("8.4.0");
    expect(exactVersionFromOverrideSpec("npm:@nolyfill/domexception@1.0.28")).toBe("1.0.28");
    expect(exactVersionFromOverrideSpec("^8.4.0")).toBeNull();
  });

  it("pins same-line pnpm lock versions to the newest locked patch", () => {
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.38", "3.972.39"]))).toBe("3.972.39");
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.39", "3.973.0"]))).toBeNull();
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.39", "4.0.0"]))).toBeNull();
  });

  it("parses nested scoped package paths", () => {
    expect(
      parseLockPackagePath("node_modules/@openclaw/codex/node_modules/@anthropic-ai/sdk"),
    ).toEqual([
      {
        name: "@openclaw/codex",
        path: "node_modules/@openclaw/codex",
      },
      {
        name: "@anthropic-ai/sdk",
        path: "node_modules/@openclaw/codex/node_modules/@anthropic-ai/sdk",
      },
    ]);
  });

  it("parses pnpm lock package keys", () => {
    expect(parsePnpmPackageKey("@aws-sdk/core@3.974.12")).toEqual({
      name: "@aws-sdk/core",
      version: "3.974.12",
    });
    expect(parsePnpmPackageKey("react-dom@19.2.4(react@19.2.4)")).toEqual({
      name: "react-dom",
      version: "19.2.4",
    });
    expect(parsePnpmPackageKey("invalid")).toBeNull();
  });

  it("disables embedded shrinkwraps that hide workspace overrides", () => {
    const lockfile = {
      packages: {
        "": {
          dependencies: {
            "lru-cache": "^11.5.0",
          },
        },
        "node_modules/@openclaw/codex": {
          version: "0.75.4",
          hasShrinkwrap: true,
        },
        "node_modules/@openclaw/codex/node_modules/protobufjs": {
          version: "7.5.9",
        },
        "node_modules/@openclaw/codex/node_modules/fetch-blob": {
          version: "4.0.0",
        },
        "node_modules/@openclaw/codex/node_modules/fetch-blob/node_modules/node-domexception": {
          version: "1.0.0",
        },
      },
    };
    const overrideRules = exactOverrideRulesFromOverrides({
      protobufjs: "8.4.0",
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
    });

    expect(collectOverrideViolations(lockfile, overrideRules)).toHaveLength(2);
    expect(disableShrinkwrappedOverrideConflictSources(lockfile, overrideRules)).toEqual([
      "node_modules/@openclaw/codex",
    ]);
    expect(lockfile.packages["node_modules/@openclaw/codex"]).not.toHaveProperty("hasShrinkwrap");
    expect(
      lockfile.packages["node_modules/@openclaw/codex/node_modules/protobufjs"],
    ).toBeUndefined();
  });

  it("detects shrinkwrap packages that bypass the pnpm lock", () => {
    const lockfile = {
      packages: {
        "": {},
        "node_modules/react": {
          version: "19.2.6",
        },
        "node_modules/@nolyfill/domexception": {
          version: "1.0.28",
        },
      },
    };
    const pnpmPackages = new Set(["react@19.2.4", "@nolyfill/domexception@1.0.28"]);

    expect(collectPnpmLockViolations(lockfile, pnpmPackages)).toEqual([
      {
        packageKey: "react@19.2.6",
        path: "node_modules/react",
      },
    ]);
  });

  it("restores current shrinkwrap entries when npm floats past pnpm's lock", () => {
    const generated = {
      packages: {
        "": {
          dependencies: {
            "lru-cache": "^11.5.0",
          },
        },
        "node_modules/lru-cache": {
          version: "11.5.1",
          resolved: "https://registry.npmjs.org/lru-cache/-/lru-cache-11.5.1.tgz",
          integrity: "sha512-new",
        },
        "node_modules/lru-memoizer/node_modules/lru-cache": {
          version: "6.0.0",
          resolved: "https://registry.npmjs.org/lru-cache/-/lru-cache-6.0.0.tgz",
          integrity: "sha512-old-major",
        },
      },
    };
    const current = {
      packages: {
        "": {},
        "node_modules/lru-cache": {
          version: "11.5.0",
          resolved: "https://registry.npmjs.org/lru-cache/-/lru-cache-11.5.0.tgz",
          integrity: "sha512-current",
        },
        "node_modules/lru-memoizer/node_modules/lru-cache": {
          version: "6.0.0",
          resolved: "https://registry.npmjs.org/lru-cache/-/lru-cache-6.0.0.tgz",
          integrity: "sha512-old-major",
        },
      },
    };
    const pnpmPackages = new Set(["lru-cache@11.5.0", "lru-cache@6.0.0"]);

    expect(restoreCurrentPnpmLockedPackages(generated, current, pnpmPackages)).toEqual({
      packages: {
        "": {
          dependencies: {
            "lru-cache": "^11.5.0",
          },
        },
        "node_modules/lru-cache": current.packages["node_modules/lru-cache"],
        "node_modules/lru-memoizer/node_modules/lru-cache":
          current.packages["node_modules/lru-memoizer/node_modules/lru-cache"],
      },
    });
  });

  it("does not restore versions that no longer satisfy the dependency edge", () => {
    const generated = {
      packages: {
        "": {
          dependencies: {
            "lru-cache": "^11.5.1",
          },
        },
        "node_modules/lru-cache": {
          version: "11.5.1",
        },
      },
    };
    const current = {
      packages: {
        "": {},
        "node_modules/lru-cache": {
          version: "11.5.0",
        },
      },
    };

    expect(
      restoreCurrentPnpmLockedPackages(generated, current, new Set(["lru-cache@11.5.0"])),
    ).toEqual(generated);
  });

  it("does not restore incompatible generated shrinkwrap versions", () => {
    const generated = {
      packages: {
        "": {},
        "node_modules/lru-cache": {
          version: "12.0.0",
        },
      },
    };
    const current = {
      packages: {
        "": {},
        "node_modules/lru-cache": {
          version: "11.5.0",
        },
      },
    };

    expect(
      restoreCurrentPnpmLockedPackages(generated, current, new Set(["lru-cache@11.5.0"])),
    ).toEqual(generated);
  });

  it("pins current shrinkwrap versions that are still in the pnpm lock", () => {
    const lockfile = {
      packages: {
        "": {},
        "node_modules/@aws-sdk/core": {
          version: "3.974.13",
        },
        "node_modules/@aws-sdk/core/node_modules/fast-xml-parser": {
          version: "5.2.5",
        },
        "node_modules/react": {
          version: "19.2.4",
        },
        "node_modules/react-dom": {
          version: "19.2.4",
        },
        "node_modules/react-dom/node_modules/react": {
          version: "19.2.5",
        },
        "node_modules/zod": {
          version: "4.4.4",
        },
      },
    };
    const pnpmPackages = new Set([
      "@aws-sdk/core@3.974.13",
      "fast-xml-parser@5.2.5",
      "react@19.2.4",
      "react@19.2.5",
      "react-dom@19.2.4",
    ]);

    expect(
      collectCurrentShrinkwrapOverrides(lockfile, new Set(["@aws-sdk/core"]), pnpmPackages),
    ).toEqual({
      "fast-xml-parser": "5.2.5",
      "react-dom": "19.2.4",
    });
  });

  it("normalizes npm patch-version metadata drift", () => {
    expect(
      normalizeNpmVersionDrift({
        packages: {
          "node_modules/@rollup/rollup-linux-x64-gnu": {
            version: "4.53.5",
            cpu: ["x64"],
            libc: ["glibc"],
            optional: true,
            os: ["linux"],
          },
          "node_modules/zod": {
            version: "4.4.3",
            deprecated: "Use another package",
            peer: true,
          },
          "node_modules/keeps-peer-false": {
            version: "1.0.0",
            peer: false,
          },
        },
      }),
    ).toEqual({
      packages: {
        "node_modules/@rollup/rollup-linux-x64-gnu": {
          version: "4.53.5",
          cpu: ["x64"],
          optional: true,
          os: ["linux"],
        },
        "node_modules/zod": {
          version: "4.4.3",
        },
        "node_modules/keeps-peer-false": {
          version: "1.0.0",
          peer: false,
        },
      },
    });
  });

  it("uses legacy peer resolution when package extensions mark dependency peers optional", () => {
    expect(
      shouldUseLegacyPeerDepsForShrinkwrap(
        { dependencies: { baileys: "7.0.0-rc13" } },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toBe(true);
    expect(
      shouldUseLegacyPeerDepsForShrinkwrap(
        { dependencies: { "not-baileys": "1.0.0" } },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toBe(false);
  });

  it("uses legacy peer resolution when the package has optional peers", () => {
    expect(
      shouldUseLegacyPeerDepsForShrinkwrap({
        dependencies: { zod: "4.4.3" },
        peerDependencies: { openclaw: ">=2026.5.30" },
        peerDependenciesMeta: { openclaw: { optional: true } },
      }),
    ).toBe(true);
  });

  it("applies package extension peer metadata to generated shrinkwrap packages", () => {
    expect(
      applyPackageExtensionPeerMetadata(
        {
          packages: {
            "node_modules/baileys": {
              version: "7.0.0-rc13",
              peerDependencies: {
                "audio-decode": "^2.1.3",
                sharp: "*",
              },
              peerDependenciesMeta: {
                "audio-decode": { optional: true },
              },
            },
          },
        },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toEqual({
      packages: {
        "node_modules/baileys": {
          version: "7.0.0-rc13",
          peerDependencies: {
            "audio-decode": "^2.1.3",
            sharp: "*",
          },
          peerDependenciesMeta: {
            "audio-decode": { optional: true },
            sharp: { optional: true },
          },
        },
      },
    });
  });

  it("targets changed publishable plugin shrinkwraps", () => {
    expect(
      shrinkwrapPackageDirsForChangedPaths([
        "extensions/acpx/package.json",
        "extensions/acpx/npm-shrinkwrap.json",
      ]).map(repoRelativePath),
    ).toEqual(["extensions/acpx"]);
  });

  it("targets changed tracked shrinkwraps for private packages", () => {
    expect(
      shrinkwrapPackageDirsForChangedPaths(["extensions/vault/package.json"]).map(repoRelativePath),
    ).toEqual(["extensions/vault"]);
  });

  it("falls back to every shrinkwrap when lockfile ownership is ambiguous", () => {
    const packageDirs = shrinkwrapPackageDirsForChangedPaths(["pnpm-lock.yaml"]).map(
      repoRelativePath,
    );

    expect(packageDirs).toContain("");
    expect(packageDirs).toContain("extensions/acpx");
    expect(packageDirs).toContain("extensions/vault");
  });

  it("falls back to every shrinkwrap when mixed lockfile changes do not map to packages", () => {
    const packageDirs = shrinkwrapPackageDirsForChangedPaths([
      "extensions/acpx/package.json",
      "pnpm-lock.yaml",
    ]).map(repoRelativePath);

    expect(packageDirs).toContain("");
    expect(packageDirs).toContain("extensions/acpx");
    expect(packageDirs.length).toBeGreaterThan(1);
  });

  it("detects package dependency inputs that make current shrinkwrap pins unsafe", () => {
    expect(
      packageDependencyInputsChanged(process.cwd(), ["scripts/generate-npm-shrinkwrap.mjs"]),
    ).toBe(true);
    expect(packageDependencyInputsChanged(process.cwd(), ["pnpm-lock.yaml"])).toBe(true);
    expect(packageDependencyInputsChanged(process.cwd(), ["package.json"])).toBe(true);
    expect(
      packageDependencyInputsChanged(path.join(process.cwd(), "extensions/acpx"), [
        "extensions/acpx/npm-shrinkwrap.json",
      ]),
    ).toBe(true);
    expect(
      packageDependencyInputsChanged(path.join(process.cwd(), "extensions/acpx"), [
        "extensions/brave/package.json",
      ]),
    ).toBe(false);
  });
});
