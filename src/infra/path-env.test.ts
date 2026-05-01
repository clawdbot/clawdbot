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

  it("appends mise shims after system dirs", () => {
    const { tmp, appCli } = setupAppCliRoot("case-mise");
    const miseDataDir = path.join(tmp, "mise");
    const shimsDir = path.join(miseDataDir, "shims");
    setDir(miseDataDir);
    setDir(shimsDir);

    process.env.MISE_DATA_DIR = miseDataDir;
    resetBootstrapEnv();

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });
    expectPathsAfter(updated, "/usr/bin", [shimsDir]);
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
    const pnpmBin = path.join(tmp, ".local", "share", "pnpm");
    const bunBin = path.join(tmp, ".bun", "bin");
    const yarnBin = path.join(tmp, ".yarn", "bin");
    setDir(path.join(tmp, ".local"));
    setDir(localBin);
    setDir(path.join(tmp, ".local", "share"));
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
    expectPathsAfter(updated, "/usr/bin", [localBin, pnpmBin, bunBin, yarnBin]);
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
});
