// Covers OpenClaw CLI PATH construction.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOpenClawCliOnPath } from "./path-env.js";

const state = vi.hoisted(() => ({
  dirs: new Set<string>(),
  executables: new Set<string>(),
}));

const abs = (p: string) => path.resolve(p);
const setDir = (p: string) => state.dirs.add(abs(p));
const setExe = (p: string) => state.executables.add(abs(p));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);

  const wrapped = {
    ...actual,
    constants: { ...actual.constants, X_OK: actual.constants.X_OK ?? 1 },
    accessSync: (p: string, mode?: number) => {
      const resolved = absInMock(p);
      if (state.executables.has(resolved)) {
        return;
      }
      actual.accessSync(p, mode);
    },
    statSync: (p: string) => {
      const resolved = absInMock(p);
      if (state.dirs.has(resolved)) {
        return {
          isDirectory: () => true,
        };
      }
      return actual.statSync(p);
    },
  };

  return { ...wrapped, default: wrapped };
});

vi.mock("./env.js", () => ({
  isTruthyEnvValue: (value?: string) => value === "1" || value === "true",
}));

describe("ensureOpenClawCliOnPath", () => {
  const envKeys = [
    "PATH",
    "OPENCLAW_PATH_BOOTSTRAPPED",
    "OPENCLAW_ALLOW_PROJECT_LOCAL_BIN",
    "MISE_DATA_DIR",
    "XDG_DATA_HOME",
    "LOCALAPPDATA",
    "PNPM_HOME",
    "NPM_CONFIG_PREFIX",
    "HOMEBREW_PREFIX",
    "HOMEBREW_BREW_FILE",
    "XDG_BIN_HOME",
  ] as const;
  let envSnapshot: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    envSnapshot = Object.fromEntries(envKeys.map((k) => [k, process.env[k]])) as typeof envSnapshot;
    state.dirs.clear();
    state.executables.clear();

    setDir("/usr/bin");
    setDir("/bin");
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of envKeys) {
      const value = envSnapshot[k];
      if (value === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = value;
      }
    }
  });

  function setupAppCliRoot(name: string) {
    const tmp = abs(`/tmp/openclaw-path/${name}`);
    const appBinDir = path.join(tmp, "AppBin");
    const appCli = path.join(appBinDir, "openclaw");
    setDir(tmp);
    setDir(appBinDir);
    setExe(appCli);
    return { tmp, appBinDir, appCli };
  }

  function bootstrapPath(params: {
    execPath: string;
    cwd: string;
    homeDir: string;
    platform: NodeJS.Platform;
    allowProjectLocalBin?: boolean;
  }) {
    ensureOpenClawCliOnPath(params);
    return (process.env.PATH ?? "").split(path.delimiter);
  }

  function resetBootstrapEnv(pathValue = "/usr/bin") {
    process.env.PATH = pathValue;
    delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
    delete process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN;
    delete process.env.HOMEBREW_PREFIX;
    delete process.env.HOMEBREW_BREW_FILE;
    delete process.env.XDG_BIN_HOME;
    delete process.env.PNPM_HOME;
    delete process.env.NPM_CONFIG_PREFIX;
    delete process.env.MISE_DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    delete process.env.LOCALAPPDATA;
  }

  function expectPathsAfter(parts: string[], anchor: string, expectedPaths: string[]) {
    const anchorIndex = parts.indexOf(anchor);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    for (const expectedPath of expectedPaths) {
      expect(
        parts.indexOf(expectedPath),
        `${expectedPath} should come after ${anchor}`,
      ).toBeGreaterThan(anchorIndex);
    }
  }

  it("prepends the bundled app bin dir when a sibling openclaw exists", () => {
    const { tmp, appBinDir, appCli } = setupAppCliRoot("case-bundled");
    resetBootstrapEnv();

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });
    expect(updated[0]).toBe(appBinDir);
  });

  it("keeps the current runtime directory ahead of system PATH hardening", () => {
    const tmp = abs("/tmp/openclaw-path/case-runtime-dir");
    const nodeBinDir = path.join(tmp, "node-bin");
    const nodeExec = path.join(nodeBinDir, "node");
    setDir(tmp);
    setDir(nodeBinDir);
    setExe(nodeExec);

    resetBootstrapEnv("/usr/bin:/bin");

    const updated = bootstrapPath({
      execPath: nodeExec,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expect(updated[0]).toBe(nodeBinDir);
    expect(updated.indexOf(nodeBinDir)).toBeLessThan(updated.indexOf("/usr/bin"));
  });

  it("is idempotent", () => {
    process.env.PATH = "/bin";
    process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";
    ensureOpenClawCliOnPath({
      execPath: "/tmp/does-not-matter",
      cwd: "/tmp",
      homeDir: "/tmp",
      platform: "darwin",
    });
    expect(process.env.PATH).toBe("/bin");
  });

  it("uses MISE_DATA_DIR before all platform defaults", () => {
    const { tmp, appCli } = setupAppCliRoot("case-mise-override");
    const miseShims = path.join(tmp, "mise-override", "shims");
    const xdgShims = path.join(tmp, "xdg-data", "mise", "shims");
    const localAppDataShims = path.join(tmp, "local-app-data", "mise", "shims");
    const homeShims = path.join(tmp, "AppData", "Local", "mise", "shims");
    for (const dir of [miseShims, xdgShims, localAppDataShims, homeShims]) {
      setDir(dir);
    }

    resetBootstrapEnv();
    process.env.MISE_DATA_DIR = path.dirname(miseShims);
    process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data");
    process.env.LOCALAPPDATA = path.join(tmp, "local-app-data");

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "win32",
    });
    expectPathsAfter(updated, "/usr/bin", [miseShims]);
    expect(updated).not.toContain(xdgShims);
    expect(updated).not.toContain(localAppDataShims);
    expect(updated).not.toContain(homeShims);
  });

  it("uses XDG_DATA_HOME before Windows platform defaults", () => {
    const { tmp, appCli } = setupAppCliRoot("case-mise-xdg-windows");
    const xdgShims = path.join(tmp, "xdg-data", "mise", "shims");
    const localAppDataShims = path.join(tmp, "local-app-data", "mise", "shims");
    const homeShims = path.join(tmp, "AppData", "Local", "mise", "shims");
    for (const dir of [xdgShims, localAppDataShims, homeShims]) {
      setDir(dir);
    }

    resetBootstrapEnv();
    process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data");
    process.env.LOCALAPPDATA = path.join(tmp, "local-app-data");

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "win32",
    });
    expectPathsAfter(updated, "/usr/bin", [xdgShims]);
    expect(updated).not.toContain(localAppDataShims);
    expect(updated).not.toContain(homeShims);
  });

  it("uses LOCALAPPDATA before the Windows HOME fallback", () => {
    const { tmp, appCli } = setupAppCliRoot("case-mise-local-app-data");
    const localAppDataShims = path.join(tmp, "local-app-data", "mise", "shims");
    const homeShims = path.join(tmp, "AppData", "Local", "mise", "shims");
    setDir(localAppDataShims);
    setDir(homeShims);

    resetBootstrapEnv();
    process.env.LOCALAPPDATA = path.join(tmp, "local-app-data");

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "win32",
    });
    expectPathsAfter(updated, "/usr/bin", [localAppDataShims]);
    expect(updated).not.toContain(homeShims);
  });

  it("uses HOME/AppData/Local when Windows overrides are absent", () => {
    const { tmp, appCli } = setupAppCliRoot("case-mise-windows-home");
    const homeShims = path.join(tmp, "AppData", "Local", "mise", "shims");
    setDir(homeShims);
    resetBootstrapEnv();

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "win32",
    });
    expectPathsAfter(updated, "/usr/bin", [homeShims]);
  });

  it("uses XDG_DATA_HOME before the Unix HOME fallback", () => {
    const { tmp, appCli } = setupAppCliRoot("case-mise-xdg-unix");
    const xdgShims = path.join(tmp, "xdg-data", "mise", "shims");
    const homeShims = path.join(tmp, ".local", "share", "mise", "shims");
    setDir(xdgShims);
    setDir(homeShims);

    resetBootstrapEnv();
    process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data");

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expectPathsAfter(updated, "/usr/bin", [xdgShims]);
    expect(updated).not.toContain(homeShims);
  });

  it("uses HOME/.local/share when Unix overrides are absent", () => {
    const { tmp, appCli } = setupAppCliRoot("case-mise-unix-home");
    const homeShims = path.join(tmp, ".local", "share", "mise", "shims");
    setDir(homeShims);
    resetBootstrapEnv();

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });
    expectPathsAfter(updated, "/usr/bin", [homeShims]);
  });

  it.each([
    {
      name: "explicit option",
      envValue: undefined,
      allowProjectLocalBin: true,
    },
    {
      name: "truthy env",
      envValue: "1",
      allowProjectLocalBin: undefined,
    },
  ])(
    "only appends project-local node_modules/.bin when enabled via $name",
    ({ envValue, allowProjectLocalBin }) => {
      const { tmp, appCli } = setupAppCliRoot("case-project-local");
      const localBinDir = path.join(tmp, "node_modules", ".bin");
      const localCli = path.join(localBinDir, "openclaw");
      setDir(path.join(tmp, "node_modules"));
      setDir(localBinDir);
      setExe(localCli);

      resetBootstrapEnv();

      const withoutOptIn = bootstrapPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
      });
      expect(withoutOptIn.includes(localBinDir)).toBe(false);

      resetBootstrapEnv();
      if (envValue === undefined) {
        delete process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN;
      } else {
        process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN = envValue;
      }

      const withOptIn = bootstrapPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
        ...(allowProjectLocalBin === undefined ? {} : { allowProjectLocalBin }),
      });
      expectPathsAfter(withOptIn, "/usr/bin", [localBinDir]);
    },
  );

  it("skips project-local bins when the working directory was deleted", () => {
    const { tmp, appCli } = setupAppCliRoot("case-deleted-cwd");
    const localBinDir = path.join(tmp, "node_modules", ".bin");
    setDir(localBinDir);
    setExe(path.join(localBinDir, "openclaw"));
    resetBootstrapEnv();
    process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN = "1";
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: uv_cwd");
    });

    try {
      ensureOpenClawCliOnPath({ execPath: appCli, homeDir: tmp, platform: "darwin" });
    } finally {
      cwdSpy.mockRestore();
    }

    expect((process.env.PATH ?? "").split(path.delimiter)).not.toContain(localBinDir);
  });

  it("prepends XDG_BIN_HOME ahead of other user bin fallbacks", () => {
    const { tmp, appCli } = setupAppCliRoot("case-xdg-bin-home");
    const xdgBinHome = path.join(tmp, "xdg-bin");
    const localBin = path.join(tmp, ".local", "bin");
    setDir(xdgBinHome);
    setDir(path.join(tmp, ".local"));
    setDir(localBin);

    resetBootstrapEnv();
    process.env.XDG_BIN_HOME = xdgBinHome;

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expect(updated.indexOf(xdgBinHome)).toBeLessThan(updated.indexOf(localBin));
  });

  it("places ~/.local/bin AFTER /usr/bin to prevent PATH hijack", () => {
    const { tmp, appCli } = setupAppCliRoot("case-path-hijack");
    const localBin = path.join(tmp, ".local", "bin");
    setDir(path.join(tmp, ".local"));
    setDir(localBin);

    resetBootstrapEnv("/usr/bin:/bin");

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expectPathsAfter(updated, "/usr/bin", [localBin]);
  });

  it("places all user-writable home dirs after system dirs", () => {
    const { tmp, appCli } = setupAppCliRoot("case-user-writable-after-system");
    const localBin = path.join(tmp, ".local", "bin");
    const npmGlobalBin = path.join(tmp, ".npm-global", "bin");
    const pnpm11Bin = path.join(tmp, ".local", "share", "pnpm", "bin");
    const pnpmBin = path.join(tmp, ".local", "share", "pnpm");
    const bunBin = path.join(tmp, ".bun", "bin");
    const yarnBin = path.join(tmp, ".yarn", "bin");
    setDir(path.join(tmp, ".local"));
    setDir(localBin);
    setDir(path.join(tmp, ".npm-global"));
    setDir(npmGlobalBin);
    setDir(path.join(tmp, ".local", "share"));
    setDir(pnpm11Bin);
    setDir(pnpmBin);
    setDir(path.join(tmp, ".bun"));
    setDir(bunBin);
    setDir(path.join(tmp, ".yarn"));
    setDir(yarnBin);

    resetBootstrapEnv("/usr/bin:/bin");

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expectPathsAfter(updated, "/usr/bin", [
      localBin,
      npmGlobalBin,
      pnpm11Bin,
      pnpmBin,
      bunBin,
      yarnBin,
    ]);
  });

  it("appends package-manager env bin dirs after system dirs", () => {
    const { tmp, appCli } = setupAppCliRoot("case-package-manager-env");
    const pnpmHome = path.join(tmp, "pnpm-home");
    const pnpmHomeBin = path.join(pnpmHome, "bin");
    const npmPrefix = path.join(tmp, "npm-prefix");
    const npmPrefixBin = path.join(npmPrefix, "bin");
    setDir(pnpmHome);
    setDir(pnpmHomeBin);
    setDir(npmPrefix);
    setDir(npmPrefixBin);

    resetBootstrapEnv("/usr/bin:/bin");
    process.env.PNPM_HOME = pnpmHome;
    process.env.NPM_CONFIG_PREFIX = npmPrefix;

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expectPathsAfter(updated, "/usr/bin", [pnpmHome, pnpmHomeBin, npmPrefixBin]);
  });

  it("keeps package-manager env roots when cwd is the filesystem root", () => {
    const { tmp, appCli } = setupAppCliRoot("case-package-manager-root-cwd");
    const pnpmHome = path.join(tmp, "pnpm-home");
    const pnpmHomeBin = path.join(pnpmHome, "bin");
    const npmPrefix = path.join(tmp, "npm-prefix");
    const npmPrefixBin = path.join(npmPrefix, "bin");
    for (const dir of [pnpmHome, pnpmHomeBin, npmPrefix, npmPrefixBin]) {
      setDir(dir);
    }

    resetBootstrapEnv("/usr/bin:/bin");
    process.env.PNPM_HOME = pnpmHome;
    process.env.NPM_CONFIG_PREFIX = npmPrefix;

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: path.parse(tmp).root,
      homeDir: tmp,
      platform: "linux",
    });

    expectPathsAfter(updated, "/usr/bin", [pnpmHome, pnpmHomeBin, npmPrefixBin]);
  });

  it("ignores relative package-manager env roots", () => {
    const { tmp, appCli } = setupAppCliRoot("case-package-manager-relative");
    resetBootstrapEnv("/usr/bin:/bin");
    process.env.PNPM_HOME = ".";
    process.env.NPM_CONFIG_PREFIX = "npm-prefix";

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });

    expect(updated).not.toContain(".");
    expect(updated).not.toContain("bin");
    expect(updated).not.toContain(path.join("npm-prefix", "bin"));
  });

  it("ignores package-manager env roots derived from the active workspace", () => {
    const homeDir = abs("/tmp/openclaw-path/home");
    const cwd = path.join(homeDir, "workspace");
    const appBinDir = path.join(homeDir, "app-bin");
    const appCli = path.join(appBinDir, "openclaw");
    const pnpmHome = path.join(cwd, ".pnpm");
    const npmPrefix = path.join(cwd, ".npm-prefix");
    for (const dir of [homeDir, cwd, appBinDir, pnpmHome, path.join(pnpmHome, "bin"), npmPrefix]) {
      setDir(dir);
    }
    setDir(path.join(npmPrefix, "bin"));
    setExe(appCli);
    resetBootstrapEnv("/usr/bin:/bin");
    process.env.PNPM_HOME = pnpmHome;
    process.env.NPM_CONFIG_PREFIX = npmPrefix;

    const updated = bootstrapPath({
      execPath: appCli,
      cwd,
      homeDir,
      platform: "linux",
    });

    expect(updated).not.toContain(pnpmHome);
    expect(updated).not.toContain(path.join(pnpmHome, "bin"));
    expect(updated).not.toContain(path.join(npmPrefix, "bin"));
  });

  it("ignores package-manager env roots whose existing parent resolves into the workspace", () => {
    const homeDir = abs("/tmp/openclaw-path/home");
    const cwd = path.join(homeDir, "workspace");
    const appBinDir = path.join(homeDir, "app-bin");
    const appCli = path.join(appBinDir, "openclaw");
    for (const dir of [homeDir, cwd, appBinDir]) {
      setDir(dir);
    }
    setExe(appCli);
    resetBootstrapEnv("/usr/bin:/bin");
    process.env.PNPM_HOME = "/tmp/workspace-link/missing-pnpm-home";

    const realpathNative = vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
      const value = String(candidate);
      if (value === "/tmp/workspace-link") {
        return cwd;
      }
      if (value === cwd || value === homeDir) {
        return value;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    try {
      const updated = bootstrapPath({
        execPath: appCli,
        cwd,
        homeDir,
        platform: "linux",
      });

      expect(updated).not.toContain(process.env.PNPM_HOME);
      expect(updated).not.toContain(path.join(process.env.PNPM_HOME, "bin"));
    } finally {
      realpathNative.mockRestore();
    }
  });

  it.each([
    {
      name: "appends Homebrew dirs after immutable OS dirs",
      setup: () => {
        const { tmp, appCli } = setupAppCliRoot("case-homebrew-after-system");
        setDir("/opt/homebrew/bin");
        setDir("/usr/local/bin");
        resetBootstrapEnv("/usr/bin:/bin");
        return {
          params: {
            execPath: appCli,
            cwd: tmp,
            homeDir: tmp,
            platform: "darwin" as const,
          },
          expectedPaths: ["/opt/homebrew/bin", "/usr/local/bin"],
          anchor: "/usr/bin",
        };
      },
    },
    {
      name: "appends Linuxbrew dirs after system dirs",
      setup: () => {
        const tmp = abs("/tmp/openclaw-path/case-linuxbrew");
        const execDir = path.join(tmp, "exec");
        setDir(tmp);
        setDir(execDir);
        const linuxbrewDir = path.join(tmp, ".linuxbrew");
        const linuxbrewBin = path.join(linuxbrewDir, "bin");
        const linuxbrewSbin = path.join(linuxbrewDir, "sbin");
        setDir(linuxbrewDir);
        setDir(linuxbrewBin);
        setDir(linuxbrewSbin);
        resetBootstrapEnv();
        return {
          params: {
            execPath: path.join(execDir, "node"),
            cwd: tmp,
            homeDir: tmp,
            platform: "linux" as const,
          },
          expectedPaths: [linuxbrewBin, linuxbrewSbin],
          anchor: "/usr/bin",
        };
      },
    },
  ])("$name", ({ setup }) => {
    const { params, expectedPaths, anchor } = setup();
    const updated = bootstrapPath(params);
    expectPathsAfter(updated, anchor, expectedPaths);
  });

  it("does not append HOMEBREW_PREFIX from process env", () => {
    const { tmp, appCli } = setupAppCliRoot("case-homebrew-env-ignored");
    const maliciousPrefix = path.join(tmp, "evil-brew");
    const maliciousBin = path.join(maliciousPrefix, "bin");
    const maliciousSbin = path.join(maliciousPrefix, "sbin");
    setDir(maliciousBin);
    setDir(maliciousSbin);
    resetBootstrapEnv("/usr/bin:/bin");
    process.env.HOMEBREW_PREFIX = maliciousPrefix;

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });

    expect(updated).not.toContain(maliciousBin);
    expect(updated).not.toContain(maliciousSbin);
  });

  it("does not probe Linuxbrew fallbacks on macOS unless already inherited", () => {
    const { tmp, appCli } = setupAppCliRoot("case-no-darwin-linuxbrew");
    const homeLinuxbrewBin = path.join(tmp, ".linuxbrew", "bin");
    const globalLinuxbrewBin = "/home/linuxbrew/.linuxbrew/bin";
    setDir(path.join(tmp, ".linuxbrew"));
    setDir(homeLinuxbrewBin);
    setDir("/home");
    setDir("/home/linuxbrew");
    setDir("/home/linuxbrew/.linuxbrew");
    setDir(globalLinuxbrewBin);
    resetBootstrapEnv("/usr/bin:/bin");

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });

    expect(updated).not.toContain(homeLinuxbrewBin);
    expect(updated).not.toContain(globalLinuxbrewBin);
  });

  it("keeps inherited Linuxbrew path entries on macOS", () => {
    const { tmp, appCli } = setupAppCliRoot("case-keep-darwin-linuxbrew");
    const globalLinuxbrewBin = "/home/linuxbrew/.linuxbrew/bin";
    resetBootstrapEnv(`${globalLinuxbrewBin}:/usr/bin:/bin`);

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });

    expect(updated).toContain(globalLinuxbrewBin);
  });
});
