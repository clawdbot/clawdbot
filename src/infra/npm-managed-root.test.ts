import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import {
  repairManagedNpmRootOpenClawPeer,
  removeManagedNpmRootDependency,
  readManagedNpmRootInstalledDependency,
  readOpenClawManagedNpmRootOverrides,
  resolveManagedNpmRootDependencySpec,
  syncManagedNpmRootPeerDependencies,
  upsertManagedNpmRootDependency,
} from "./npm-managed-root.js";

const tempDirs: string[] = [];

const successfulSpawn = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit" as const,
};

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-managed-root-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const statError = error as NodeJS.ErrnoException;
    expect({
      code: statError.code,
      path: statError.path,
      syscall: statError.syscall,
    }).toEqual({
      code: "ENOENT",
      path: targetPath,
      syscall: "lstat",
    });
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

function requireFirstMockCall<T extends unknown[]>(
  mock: { mock: { calls: T[] } },
  label: string,
): T {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function requireCommandOptions(
  options: number | CommandOptions | undefined,
  label: string,
): CommandOptions {
  if (!options || typeof options === "number") {
    throw new Error(`expected ${label} command options`);
  }
  return options;
}

describe("managed npm root", () => {
  it("keeps existing plugin dependencies when adding another managed plugin", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/discord": "2026.5.2",
          },
          devDependencies: {
            fixture: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/feishu",
      dependencySpec: "2026.5.2",
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
        "@openclaw/feishu": "2026.5.2",
      },
      devDependencies: {
        fixture: "1.0.0",
      },
    });
  });

  it("syncs OpenClaw-owned overrides without dropping unrelated local overrides", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/discord": "2026.5.2",
          },
          overrides: {
            axios: "1.13.6",
            "left-pad": "1.3.0",
            qs: "6.14.0",
          },
          openclaw: {
            managedOverrides: ["axios", "qs"],
          },
        },
        null,
        2,
      )}\n`,
    );

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/feishu",
      dependencySpec: "2026.5.4",
      managedOverrides: {
        axios: "1.16.0",
        "node-domexception": "npm:@nolyfill/domexception@1.0.28",
        nested: {
          semver: "1.2.3",
          alias: "npm:@scope/alias@1.0.0",
        },
      },
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
        "@openclaw/feishu": "2026.5.4",
      },
      overrides: {
        "left-pad": "1.3.0",
        axios: "1.16.0",
        "node-domexception": "npm:@nolyfill/domexception@1.0.28",
        nested: {
          alias: "npm:@scope/alias@1.0.0",
          semver: "1.2.3",
        },
      },
      openclaw: {
        managedOverrides: ["axios", "nested", "node-domexception"],
      },
    });
  });

  it("can omit npm alias overrides for npm versions that reject them", async () => {
    const npmRoot = await makeTempRoot();

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/feishu",
      dependencySpec: "2026.5.4",
      omitUnsupportedManagedOverrides: true,
      managedOverrides: {
        axios: "1.16.0",
        "node-domexception": "npm:@nolyfill/domexception@1.0.28",
        nested: {
          alias: "npm:@scope/alias@1.0.0",
          semver: "1.2.3",
        },
      },
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toMatchObject({
      overrides: {
        axios: "1.16.0",
        nested: {
          semver: "1.2.3",
        },
      },
      openclaw: {
        managedOverrides: ["axios", "nested"],
      },
    });
  });

  it("reads package-level npm overrides for managed plugin installs", async () => {
    await expect(readOpenClawManagedNpmRootOverrides()).resolves.toEqual({
      axios: "1.16.0",
      "fast-uri": "3.1.2",
      "follow-redirects": "1.16.0",
      "ip-address": "10.2.0",
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
      uuid: "14.0.0",
    });
  });

  it("resolves package-level npm overrides from packaged dist chunks", async () => {
    const packageRoot = await makeTempRoot();
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "openclaw",
          overrides: {
            axios: "1.16.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      readOpenClawManagedNpmRootOverrides({
        moduleUrl: pathToFileURL(path.join(packageRoot, "dist", "install-AbCdEf.js")).toString(),
        cwd: path.join(packageRoot, "dist"),
      }),
    ).resolves.toEqual({
      axios: "1.16.0",
    });
  });

  it("resolves npm override dependency references from the host package manifest", async () => {
    const packageRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "openclaw",
          dependencies: {
            "@aws-sdk/client-bedrock-runtime": "3.1024.0",
            "node-domexception": "npm:@nolyfill/domexception@1.0.28",
          },
          optionalDependencies: {
            "optional-runtime": "2.0.0",
          },
          overrides: {
            "@aws-sdk/client-bedrock-runtime": "$@aws-sdk/client-bedrock-runtime",
            nested: {
              "optional-runtime": "$optional-runtime",
              alias: "$node-domexception",
            },
            axios: "1.16.0",
            "node-domexception": "$node-domexception",
          },
        },
        null,
        2,
      )}\n`,
    );

    await expect(readOpenClawManagedNpmRootOverrides({ packageRoot })).resolves.toEqual({
      "@aws-sdk/client-bedrock-runtime": "3.1024.0",
      nested: {
        "optional-runtime": "2.0.0",
        alias: "npm:@nolyfill/domexception@1.0.28",
      },
      axios: "1.16.0",
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
    });
  });

  it("does not overwrite a present malformed package manifest", async () => {
    const npmRoot = await makeTempRoot();
    const manifestPath = path.join(npmRoot, "package.json");
    await fs.writeFile(manifestPath, "{not-json", "utf8");

    await expect(
      upsertManagedNpmRootDependency({
        npmRoot,
        packageName: "@openclaw/feishu",
        dependencySpec: "2026.5.2",
      }),
    ).rejects.toThrow(/JSON|package\.json|not-json/i);

    await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe("{not-json");
  });

  it("pins managed dependencies to the resolved version", () => {
    expect(
      resolveManagedNpmRootDependencySpec({
        parsedSpec: {
          name: "@openclaw/discord",
          raw: "@openclaw/discord@stable",
          selector: "stable",
          selectorKind: "tag",
          selectorIsPrerelease: false,
        },
        resolution: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/discord@2026.5.2",
          resolvedAt: "2026-05-03T00:00:00.000Z",
        },
      }),
    ).toBe("2026.5.2");

    expect(
      resolveManagedNpmRootDependencySpec({
        parsedSpec: {
          name: "@openclaw/discord",
          raw: "@openclaw/discord",
          selectorKind: "none",
          selectorIsPrerelease: false,
        },
        resolution: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/discord@2026.5.2",
          resolvedAt: "2026-05-03T00:00:00.000Z",
        },
      }),
    ).toBe("2026.5.2");
  });

  it("reads installed dependency metadata from package-lock", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "node_modules/@openclaw/discord": {
              version: "2026.5.2",
              resolved: "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.5.2.tgz",
              integrity: "sha512-discord",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      readManagedNpmRootInstalledDependency({
        npmRoot,
        packageName: "@openclaw/discord",
      }),
    ).resolves.toEqual({
      version: "2026.5.2",
      resolved: "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.5.2.tgz",
      integrity: "sha512-discord",
    });
  });

  it("syncs managed peer dependencies from npm's resolved lockfile plan", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "existing-root": "1.0.0",
            "old-peer": "1.0.0",
            plugin: "1.0.0",
          },
          devDependencies: {
            "dev-plugin": "1.0.0",
          },
          openclaw: {
            managedPeerDependencies: ["old-peer"],
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      const tempManifest = JSON.parse(
        await fs.readFile(path.join(options.cwd, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
      };
      expect(tempManifest.dependencies).toEqual({
        "existing-root": "1.0.0",
        plugin: "1.0.0",
      });
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify(
          {
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: tempManifest.dependencies,
              },
              "node_modules/existing-root": {
                version: "1.0.0",
              },
              "node_modules/dev-peer": {
                dev: true,
                version: "3.0.0",
              },
              "node_modules/dev-plugin": {
                dev: true,
                peerDependencies: {
                  "dev-peer": "^3.0.0",
                },
                version: "1.0.0",
              },
              "node_modules/new-peer": {
                peer: true,
                version: "2.1.0",
              },
              "node_modules/openclaw": {
                peer: true,
                version: "2026.5.12",
              },
              "node_modules/plugin": {
                peerDependencies: {
                  "existing-root": "^1.0.0",
                  "new-peer": "^2.0.0",
                  openclaw: ">=2026.5.0",
                },
                version: "1.0.0",
              },
              "node_modules/unsupported-optional": {
                optional: true,
                os: [process.platform === "win32" ? "darwin" : "win32"],
                peerDependencies: {
                  "unsupported-peer": "^9.0.0",
                },
                version: "1.0.0",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      return successfulSpawn;
    });

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(true);

    const [args, rawOptions] = requireFirstMockCall(runCommand, "npm peer plan command");
    const options = requireCommandOptions(rawOptions, "npm peer plan");
    expect(args).toEqual([
      "npm",
      "install",
      "--package-lock-only",
      "--force",
      "--omit=dev",
      "--omit=peer",
      "--loglevel=error",
      "--ignore-scripts",
      "--workspaces=false",
      "--no-audit",
      "--no-fund",
    ]);
    expect(options?.cwd).not.toBe(npmRoot);
    expect(options?.env?.npm_config_legacy_peer_deps).toBe("false");

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "existing-root": "1.0.0",
        "new-peer": "2.1.0",
        plugin: "1.0.0",
      },
      devDependencies: {
        "dev-plugin": "1.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["new-peer"],
      },
    });
  });

  it("preserves existing managed peer dependencies when npm cannot plan third-party peers", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            plugin: "1.0.0",
            "runtime-peer": "2.0.0",
          },
          openclaw: {
            managedPeerDependencies: ["runtime-peer"],
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "npm ERR! ERESOLVE could not resolve third-party peer dependency",
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(1);
    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "2.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });
  });

  it("uses lockfile metadata to preserve non-host peers when host peer planning fails", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            plugin: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      if (runCommand.mock.calls.length === 1) {
        return {
          code: 1,
          stdout: "",
          stderr: "npm ERR! notarget No matching version found for openclaw@2026.5.99-beta.1",
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify(
          {
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  plugin: "1.0.0",
                },
              },
              "node_modules/plugin": {
                peerDependencies: {
                  openclaw: "2026.5.99-beta.1",
                  "runtime-peer": "^2.0.0",
                },
                version: "1.0.0",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      return successfulSpawn;
    });

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(2);
    const [strictArgs, rawStrictOptions] = runCommand.mock.calls[0] ?? [];
    const [fallbackArgs, rawFallbackOptions] = runCommand.mock.calls[1] ?? [];
    const strictOptions = requireCommandOptions(rawStrictOptions, "strict npm peer plan");
    const fallbackOptions = requireCommandOptions(rawFallbackOptions, "fallback npm peer plan");
    expect(strictArgs).not.toContain("--legacy-peer-deps");
    expect(strictOptions.env?.npm_config_legacy_peer_deps).toBe("false");
    expect(fallbackArgs).toContain("--legacy-peer-deps");
    expect(fallbackOptions.env?.npm_config_legacy_peer_deps).toBe("true");
    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "^2.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });
  });

  it("does not promote nested transitive lockfile versions into managed root peers", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            plugin: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify(
          {
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  plugin: "1.0.0",
                },
              },
              "node_modules/plugin": {
                peerDependencies: {
                  "runtime-peer": "^2.0.0",
                },
                version: "1.0.0",
              },
              "node_modules/transitive": {
                version: "1.0.0",
              },
              "node_modules/transitive/node_modules/runtime-peer": {
                version: "1.0.0",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      return successfulSpawn;
    });

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(true);

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "^2.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });
  });

  it("removes one managed dependency without dropping unrelated metadata", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/discord": "2026.5.2",
            "@openclaw/voice-call": "2026.5.2",
          },
          devDependencies: {
            fixture: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    await removeManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/voice-call",
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
      },
      devDependencies: {
        fixture: "1.0.0",
      },
    });
  });

  it("repairs stale managed openclaw peer state without dropping plugin packages", async () => {
    const npmRoot = await makeTempRoot();
    await fs.mkdir(path.join(npmRoot, "node_modules", "openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            openclaw: "2026.5.4",
            "@openclaw/discord": "2026.5.4",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(npmRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: {
                openclaw: "2026.5.4",
                "@openclaw/discord": "2026.5.4",
              },
            },
            "node_modules/openclaw": {
              version: "2026.5.4",
            },
            "node_modules/@openclaw/discord": {
              version: "2026.5.4",
            },
          },
          dependencies: {
            openclaw: {
              version: "2026.5.4",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(npmRoot, "node_modules", "openclaw", "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.5.4" })}\n`,
    );
    await fs.mkdir(path.join(npmRoot, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw"), "shim");
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw.cmd"), "cmd shim");
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw.ps1"), "ps1 shim");
    await fs.writeFile(
      path.join(npmRoot, "node_modules", ".package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "node_modules/openclaw": {
              version: "2026.5.4",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn().mockResolvedValue(successfulSpawn);
    await expect(repairManagedNpmRootOpenClawPeer({ npmRoot, runCommand })).resolves.toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [repairArgs, rawRepairOptions] = requireFirstMockCall(runCommand, "repair command");
    const repairOptions = requireCommandOptions(rawRepairOptions, "repair");
    expect(repairArgs).toEqual([
      "npm",
      "uninstall",
      "--loglevel=error",
      "--legacy-peer-deps",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "openclaw",
    ]);
    expect(repairOptions?.cwd).toBe(npmRoot);
    expect(repairOptions?.timeoutMs).toBe(300_000);
    expect(repairOptions?.env?.npm_config_legacy_peer_deps).toBe("true");

    const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      "@openclaw/discord": "2026.5.4",
    });
    const lockfile = JSON.parse(
      await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
      dependencies?: Record<string, unknown>;
    };
    expect(lockfile.packages?.[""]?.dependencies).toEqual({
      "@openclaw/discord": "2026.5.4",
    });
    expect(lockfile.packages?.["node_modules/openclaw"]).toBeUndefined();
    expect(lockfile.packages?.["node_modules/@openclaw/discord"]?.version).toBe("2026.5.4");
    expect(lockfile.dependencies?.openclaw).toBeUndefined();
    await expectPathMissing(path.join(npmRoot, "node_modules", "openclaw"));
    for (const binName of ["openclaw", "openclaw.cmd", "openclaw.ps1"]) {
      await expectPathMissing(path.join(npmRoot, "node_modules", ".bin", binName));
    }
    await expectPathMissing(path.join(npmRoot, "node_modules", ".package-lock.json"));
  });

  it("does not repair the active OpenClaw host package in a root-managed install", async () => {
    const npmRoot = await makeTempRoot();
    const hostPackageRoot = path.join(npmRoot, "node_modules", "openclaw");
    await fs.mkdir(path.join(hostPackageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            openclaw: "2026.5.12-beta.6",
            "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(npmRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: {
                openclaw: "2026.5.12-beta.6",
                "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
              },
            },
            "node_modules/openclaw": {
              version: "2026.5.12-beta.6",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(hostPackageRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.5.12-beta.6" })}\n`,
    );

    const runCommand = vi.fn().mockResolvedValue(successfulSpawn);
    await expect(
      repairManagedNpmRootOpenClawPeer({
        npmRoot,
        packageRoot: hostPackageRoot,
        runCommand,
      }),
    ).resolves.toBe(false);

    expect(runCommand).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toMatchObject({
      dependencies: {
        openclaw: "2026.5.12-beta.6",
        "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
      },
    });
    await expect(
      fs.readFile(path.join(hostPackageRoot, "package.json"), "utf8"),
    ).resolves.toContain("2026.5.12-beta.6");
  });

  it("scrubs managed ownership metadata without deleting a linked active host package", async () => {
    const npmRoot = await makeTempRoot();
    const hostPackageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-package-"));
    tempDirs.push(hostPackageRoot);
    await fs.mkdir(path.join(npmRoot, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(
      path.join(hostPackageRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.5.12-beta.6" })}\n`,
    );
    await fs.symlink(hostPackageRoot, path.join(npmRoot, "node_modules", "openclaw"), "dir");
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw"), "shim");
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw.cmd"), "cmd shim");
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw.ps1"), "ps1 shim");
    await fs.writeFile(
      path.join(npmRoot, "node_modules", ".package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "node_modules/openclaw": {
              version: "2026.5.12-beta.6",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            openclaw: "2026.5.12-beta.6",
            "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(npmRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: {
                openclaw: "2026.5.12-beta.6",
                "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
              },
            },
            "node_modules/openclaw": {
              version: "2026.5.12-beta.6",
            },
            "node_modules/@xdarkicex/openclaw-memory-libravdb": {
              version: "1.4.69",
            },
          },
          dependencies: {
            openclaw: {
              version: "2026.5.12-beta.6",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn().mockResolvedValue(successfulSpawn);
    await expect(
      repairManagedNpmRootOpenClawPeer({
        npmRoot,
        packageRoot: hostPackageRoot,
        runCommand,
      }),
    ).resolves.toBe(true);

    expect(runCommand).not.toHaveBeenCalled();
    await expect(fs.realpath(path.join(npmRoot, "node_modules", "openclaw"))).resolves.toBe(
      await fs.realpath(hostPackageRoot),
    );
    await expect(
      fs.readFile(path.join(hostPackageRoot, "package.json"), "utf8"),
    ).resolves.toContain("2026.5.12-beta.6");

    const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
    });

    const lockfile = JSON.parse(
      await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
      dependencies?: Record<string, unknown>;
    };
    expect(lockfile.packages?.[""]?.dependencies).toEqual({
      "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
    });
    expect(lockfile.packages?.["node_modules/openclaw"]).toBeUndefined();
    expect(lockfile.packages?.["node_modules/@xdarkicex/openclaw-memory-libravdb"]?.version).toBe(
      "1.4.69",
    );
    expect(lockfile.dependencies?.openclaw).toBeUndefined();
    for (const binName of ["openclaw", "openclaw.cmd", "openclaw.ps1"]) {
      await expectPathMissing(path.join(npmRoot, "node_modules", ".bin", binName));
    }
    await expectPathMissing(path.join(npmRoot, "node_modules", ".package-lock.json"));
  });
});
