import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout, type CommandOptions } from "../process/exec.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { installPackageDir } from "./install-package-dir.js";

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: vi.fn(actual.runCommandWithTimeout),
  };
});

async function listMatchingDirs(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) {
      names.push(entry.name);
    }
  }
  return names;
}

async function listMatchingEntries(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(prefix)) {
      names.push(entry.name);
    }
  }
  return names;
}

function normalizeDarwinTmpPath(filePath: string): string {
  return process.platform === "darwin" && filePath.startsWith("/private/var/")
    ? filePath.slice("/private".length)
    : filePath;
}

function normalizeComparablePath(filePath: string): string {
  const resolved = normalizeDarwinTmpPath(path.resolve(filePath));
  const parent = normalizeDarwinTmpPath(path.dirname(resolved));
  let comparableParent = parent;
  try {
    comparableParent = normalizeDarwinTmpPath(fsSync.realpathSync.native(parent));
  } catch {
    comparableParent = parent;
  }
  const basename =
    process.platform === "win32" ? path.basename(resolved).toLowerCase() : path.basename(resolved);
  return path.join(comparableParent, basename);
}

function createFsError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function expectMissingPath(filePath: string): Promise<void> {
  try {
    await fs.stat(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

function expectRunCommandCallForArgv(
  expectedArgv: string[],
  predicate?: (options: CommandOptions) => boolean,
): CommandOptions {
  const calls = vi.mocked(runCommandWithTimeout).mock.calls as [
    string[],
    number | CommandOptions,
  ][];
  for (const [argv, optionsOrTimeout] of calls.toReversed()) {
    if (
      JSON.stringify(argv) !== JSON.stringify(expectedArgv) ||
      typeof optionsOrTimeout === "number"
    ) {
      continue;
    }
    if (!predicate || predicate(optionsOrTimeout)) {
      return optionsOrTimeout;
    }
  }
  throw new Error(`Expected runCommandWithTimeout call: ${expectedArgv.join(" ")}`);
}

async function rebindInstallBasePath(params: {
  installBaseDir: string;
  preservedDir: string;
  outsideTarget: string;
}): Promise<void> {
  await fs.rename(params.installBaseDir, params.preservedDir);
  await fs.symlink(
    params.outsideTarget,
    params.installBaseDir,
    process.platform === "win32" ? "junction" : undefined,
  );
}

async function withInstallBaseReboundOnRealpathCall<T>(params: {
  installBaseDir: string;
  preservedDir: string;
  outsideTarget: string;
  rebindAtCall: number;
  run: () => Promise<T>;
}): Promise<T> {
  const installBasePath = normalizeComparablePath(params.installBaseDir);
  const realRealpath = fs.realpath.bind(fs);
  let installBaseRealpathCalls = 0;
  const realpathSpy = vi
    .spyOn(fs, "realpath")
    .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const filePath = normalizeComparablePath(String(args[0]));
      if (filePath === installBasePath) {
        installBaseRealpathCalls += 1;
        if (installBaseRealpathCalls === params.rebindAtCall) {
          await rebindInstallBasePath({
            installBaseDir: params.installBaseDir,
            preservedDir: params.preservedDir,
            outsideTarget: params.outsideTarget,
          });
        }
      }
      return await realRealpath(...args);
    });
  try {
    return await params.run();
  } finally {
    realpathSpy.mockRestore();
  }
}

async function createExistingInstallFixture(fixtureRoot: string) {
  const installBaseDir = path.join(fixtureRoot, "plugins");
  const sourceDir = path.join(fixtureRoot, "source");
  const targetDir = path.join(installBaseDir, "demo");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");
  await fs.writeFile(path.join(targetDir, "marker.txt"), "old");
  return { installBaseDir, sourceDir, targetDir };
}

async function createReboundInstallFixture(params: {
  fixtureRoot: string;
  withExistingInstall?: boolean;
}) {
  const sourceDir = path.join(params.fixtureRoot, "source");
  const installBaseDir = path.join(params.fixtureRoot, "plugins");
  const preservedInstallRoot = path.join(params.fixtureRoot, "plugins-preserved");
  const outsideInstallRoot = path.join(params.fixtureRoot, "outside-plugins");
  const targetDir = path.join(installBaseDir, "demo");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(installBaseDir, { recursive: true });
  await fs.mkdir(outsideInstallRoot, { recursive: true });
  if (params.withExistingInstall) {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "marker.txt"), "old");
  }
  await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");
  return { installBaseDir, outsideInstallRoot, preservedInstallRoot, sourceDir, targetDir };
}

describe("installPackageDir", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-install-package-dir-",
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  it("keeps the existing install in place when staged validation fails", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const { installBaseDir, sourceDir, targetDir } =
      await createExistingInstallFixture(fixtureRoot);

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "update",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "Installing deps…",
      afterCopy: async (installedDir) => {
        expect(installedDir).not.toBe(targetDir);
        await expect(fs.readFile(path.join(installedDir, "marker.txt"), "utf8")).resolves.toBe(
          "new",
        );
        throw new Error("validation boom");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "post-copy validation failed: Error: validation boom",
    });
    await expect(fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).resolves.toBe("old");
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-backups"),
    ).resolves.toHaveLength(0);
  });

  it("restores the original install if publish rename fails", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const { installBaseDir, sourceDir, targetDir } =
      await createExistingInstallFixture(fixtureRoot);

    const realRename = fs.rename.bind(fs);
    let renameCalls = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      renameCalls += 1;
      if (renameCalls === 2) {
        throw new Error("publish boom");
      }
      return await realRename(...args);
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "update",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "Installing deps…",
    });

    expect(result).toEqual({
      ok: false,
      error: "failed to copy plugin: Error: publish boom",
    });
    await expect(fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).resolves.toBe("old");
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
    const backupRoot = path.join(installBaseDir, ".openclaw-install-backups");
    await expect(fs.readdir(backupRoot)).resolves.toHaveLength(0);
  });

  it("publishes the staged install through the copy fallback when rename crosses devices", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const sourceDir = path.join(fixtureRoot, "source");
    const installBaseDir = path.join(fixtureRoot, "plugins");
    const targetDir = path.join(installBaseDir, "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");

    const realRename = fs.rename.bind(fs);
    let exdevMoves = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      const [from, to] = args;
      const fromPath = String(from);
      if (
        exdevMoves === 0 &&
        path.basename(fromPath).startsWith(".openclaw-install-stage-") &&
        normalizeComparablePath(String(to)) === normalizeComparablePath(targetDir)
      ) {
        exdevMoves += 1;
        throw createFsError("EXDEV", "cross-device link not permitted");
      }
      return await realRename(...args);
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "install",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "Installing deps…",
    });

    expect(result).toEqual({ ok: true });
    expect(exdevMoves).toBe(1);
    await expect(fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).resolves.toBe("new");
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
  });

  it("aborts without outside writes when the install base is rebound before publish", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const { installBaseDir, outsideInstallRoot, preservedInstallRoot, sourceDir, targetDir } =
      await createReboundInstallFixture({ fixtureRoot });

    const warnings: string[] = [];
    await withInstallBaseReboundOnRealpathCall({
      installBaseDir,
      preservedDir: preservedInstallRoot,
      outsideTarget: outsideInstallRoot,
      rebindAtCall: 4,
      run: async () => {
        await expect(
          installPackageDir({
            sourceDir,
            targetDir,
            mode: "install",
            timeoutMs: 1_000,
            copyErrorPrefix: "failed to copy plugin",
            hasDeps: false,
            depsLogMessage: "Installing deps…",
            logger: { warn: (message) => warnings.push(message) },
          }),
        ).resolves.toEqual({
          ok: false,
          error: "failed to copy plugin: Error: install base directory changed during install",
        });
      },
    });

    await expectMissingPath(path.join(outsideInstallRoot, "demo", "marker.txt"));
    expect(warnings).toContain(
      "Install base directory changed during install; aborting staged publish.",
    );
  });

  it("warns and leaves the backup in place when the install base changes before backup cleanup", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const { installBaseDir, outsideInstallRoot, preservedInstallRoot, sourceDir, targetDir } =
      await createReboundInstallFixture({ fixtureRoot, withExistingInstall: true });

    const warnings: string[] = [];
    const installBasePath = normalizeComparablePath(installBaseDir);
    const realStat = fs.stat.bind(fs);
    let installBaseStatCalls = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (normalizeComparablePath(String(args[0])) === installBasePath) {
        installBaseStatCalls += 1;
        if (installBaseStatCalls === 3) {
          await rebindInstallBasePath({
            installBaseDir,
            preservedDir: preservedInstallRoot,
            outsideTarget: outsideInstallRoot,
          });
        }
      }
      return await realStat(...args);
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "update",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "Installing deps…",
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(result).toEqual({ ok: true });
    expect(installBaseStatCalls).toBe(3);
    expect(warnings).toContain(
      "Install base directory changed before backup cleanup; leaving backup in place.",
    );
    await expectMissingPath(path.join(outsideInstallRoot, "demo", "marker.txt"));
    const backupRoot = path.join(preservedInstallRoot, ".openclaw-install-backups");
    await expect(fs.readdir(backupRoot)).resolves.toHaveLength(1);
  });

  it("installs peer dependencies for isolated plugin package installs", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "plugins", "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "demo-plugin",
        version: "1.0.0",
        dependencies: {
          zod: "^4.0.0",
        },
      }),
      "utf-8",
    );

    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "install",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: true,
      depsLogMessage: "Installing deps…",
    });

    expect(result).toEqual({ ok: true });
    const installOptions = expectRunCommandCallForArgv([
      "npm",
      "install",
      "--omit=dev",
      "--loglevel=error",
      "--ignore-scripts",
    ]);
    expect(installOptions.cwd).toContain(".openclaw-install-stage-");
  });

  it("hides the staged project .npmrc while npm install runs and restores it afterward", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "plugins", "demo");
    const npmrcContent = "git=calc.exe\n";
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "demo-plugin",
        version: "1.0.0",
        dependencies: {
          zod: "^4.0.0",
        },
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(sourceDir, ".npmrc"), npmrcContent, "utf-8");

    vi.mocked(runCommandWithTimeout).mockImplementation(async (_argv, optionsOrTimeout) => {
      const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
      if (cwd === undefined) {
        throw new Error("expected package install cwd");
      }
      await expectMissingPath(path.join(cwd, ".npmrc"));
      await expect(
        listMatchingEntries(cwd, ".openclaw-install-hidden-npmrc-"),
      ).resolves.toHaveLength(1);
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "install",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: true,
      depsLogMessage: "Installing deps…",
    });

    expect(result).toEqual({ ok: true });
    await expect(fs.readFile(path.join(targetDir, ".npmrc"), "utf8")).resolves.toBe(npmrcContent);
    await expect(
      listMatchingEntries(targetDir, ".openclaw-install-hidden-npmrc-"),
    ).resolves.toHaveLength(0);
  });

  it("forces dependency installs to stay project-local when npm global config leaks in", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "plugins", "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "demo-plugin",
        version: "1.0.0",
        dependencies: {
          zod: "^4.0.0",
        },
      }),
      "utf-8",
    );

    vi.stubEnv("NPM_CONFIG_GLOBAL", "true");
    vi.stubEnv("npm_config_global", "true");
    vi.stubEnv("NPM_CONFIG_LOCATION", "global");
    vi.stubEnv("npm_config_location", "global");
    vi.stubEnv("NPM_CONFIG_PREFIX", path.join(fixtureRoot, "global-prefix-uppercase"));
    vi.stubEnv("npm_config_prefix", path.join(fixtureRoot, "global-prefix"));
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "install",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: true,
      depsLogMessage: "Installing deps…",
    });

    expect(result).toEqual({ ok: true });
    const installOptions = expectRunCommandCallForArgv(
      ["npm", "install", "--omit=dev", "--loglevel=error", "--ignore-scripts"],
      (options) => options.env?.npm_config_global === "false",
    );
    const env = installOptions.env ?? {};
    expect(env.npm_config_global).toBe("false");
    expect(env.npm_config_location).toBe("project");
    expect(env.npm_config_package_lock).toBe("false");
    expect(env.npm_config_save).toBe("false");
    expect("NPM_CONFIG_GLOBAL" in env).toBe(false);
    expect("NPM_CONFIG_LOCATION" in env).toBe(false);
    expect("NPM_CONFIG_PREFIX" in env).toBe(false);
    expect("npm_config_prefix" in env).toBe(false);
  });

  it("surfaces npm stderr when dependency install fails", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "plugins", "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "demo-plugin",
        version: "1.0.0",
        dependencies: {
          bad: "workspace:^",
        },
      }),
      "utf-8",
    );

    // Mirrors the Blacksmith repro: npm 11 preserved this stderr with
    // `--loglevel=error`, while `--silent` returned empty output.
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "",
      stderr:
        'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:^\n',
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "install",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: true,
      depsLogMessage: "Installing deps…",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("npm install failed:");
      expect(result.error).toContain("EUNSUPPORTEDPROTOCOL");
      expect(result.error).toContain("workspace:");
    }
  });
});
