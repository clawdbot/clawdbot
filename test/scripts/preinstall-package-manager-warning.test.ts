// Preinstall Package Manager Warning tests cover preinstall package manager warning script behavior.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../scripts/lib/package-dist-inventory.ts";
import {
  completePackageInstallGuard,
  createPackageManagerWarningMessage,
  detectLifecyclePackageManager,
  enforceSupportedNodeRuntime,
  nodeVersionSatisfiesPackageEngine,
  PACKAGE_INSTALL_GUARD_RELATIVE_PATH as PREINSTALL_GUARD_RELATIVE_PATH,
  probePackageCliNodeRuntime,
  readPackageNodeEngine,
  warnIfNonPnpmLifecycle,
} from "../../scripts/preinstall-package-manager-warning.mjs";
import { isSupportedNodeVersion } from "../../src/infra/runtime-guard.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const EXPECTED_NODE_ENGINE_RANGE = ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireFirstWarning(warn: ReturnType<typeof vi.fn>): unknown {
  const [call] = warn.mock.calls;
  if (!call) {
    throw new Error("expected package manager warning");
  }
  const [message] = call;
  if (message === undefined) {
    throw new Error("expected package manager warning");
  }
  return message;
}

describe("install runtime enforcement", () => {
  it("shares the packaged install guard path", () => {
    expect(PREINSTALL_GUARD_RELATIVE_PATH).toBe(PACKAGE_INSTALL_GUARD_RELATIVE_PATH);
  });

  it("reads the canonical package engine range", () => {
    expect(readPackageNodeEngine()).toBe(EXPECTED_NODE_ENGINE_RANGE);
  });

  it.each(["22.22.2", "22.22.3", "23.11.0", "24.14.1", "24.15.0", "25.8.1", "25.9.0", "26.0.0"])(
    "matches the CLI runtime guard for Node %s",
    (version) => {
      expect(nodeVersionSatisfiesPackageEngine(version, EXPECTED_NODE_ENGINE_RANGE)).toBe(
        isSupportedNodeVersion(version),
      );
    },
  );

  it.each(["24.15.0-rc.1", "25.9.1-nightly.20260714", "24.15", "24.15.0+", "24.15.0+local..1"])(
    "rejects non-release Node version %s",
    (version) => {
      expect(nodeVersionSatisfiesPackageEngine(version, EXPECTED_NODE_ENGINE_RANGE)).toBe(false);
    },
  );

  it("accepts SemVer build metadata on a supported Node release", () => {
    expect(nodeVersionSatisfiesPackageEngine("24.15.0+local.1", EXPECTED_NODE_ENGINE_RANGE)).toBe(
      true,
    );
  });

  it("blocks unsupported Node before package replacement", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          version: "24.14.1",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          execPath: "/opt/node/bin/node",
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("this OpenClaw release requires Node"),
    );
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining("detected Node 24.14.1"));
  });

  it("allows supported Node without an error", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          version: "24.15.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          execPath: "/opt/node/bin/node",
        },
        reportError,
      ),
    ).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("exits nonzero when the packed entrypoint sees an unsupported runtime", () => {
    const root = tempDirs.make("openclaw-preinstall-", realpathSync(tmpdir()));
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir);
    const scriptPath = join(scriptsDir, "preinstall-package-manager-warning.mjs");
    copyFileSync(
      new URL("../../scripts/preinstall-package-manager-warning.mjs", import.meta.url),
      scriptPath,
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { node: ">=999.0.0" } }));

    const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires Node >=999.0.0");
    expect(result.stderr).toContain(`detected Node ${process.versions.node}`);
  });

  it("allows Bun package lifecycle scripts when the installed CLI will use supported Node", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          version: "24.14.1",
          bunVersion: "1.3.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          execPath: "/opt/bun/bin/bun",
          probeNodeRuntime: () => ({
            version: "24.15.0",
            bunVersion: null,
            execPath: "/opt/node/bin/node",
          }),
        },
        reportError,
      ),
    ).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("blocks Bun package lifecycle scripts when the installed CLI will use old Node", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          bunVersion: "1.3.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          probeNodeRuntime: () => ({
            version: "24.14.1",
            bunVersion: null,
            execPath: "/opt/node/bin/node",
          }),
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining("detected Node 24.14.1"));
  });

  it("blocks Bun package lifecycle scripts when no real Node follows its shim", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          bunVersion: "1.3.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          probeNodeRuntime: () => null,
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining("detected Node missing"));
  });

  it("strips only Bun's cwd-to-root lifecycle PATH prefix", () => {
    const candidates: string[] = [];
    const runtime = probePackageCliNodeRuntime({
      cwd: "/work/openclaw",
      pathEnv: [
        "/work/openclaw/node_modules/.bin",
        "/work/node_modules/.bin",
        "/node_modules/.bin",
        "/opt/node/bin",
      ].join(":"),
      platform: "linux",
      run: (command) => {
        candidates.push(command);
        return {
          status: 0,
          stdout: JSON.stringify({
            version: "24.15.0",
            bunVersion: null,
            execPath: "/opt/node/bin/node",
          }),
        };
      },
    });

    expect(candidates).toEqual(["/opt/node/bin/node"]);
    expect(runtime).toEqual({
      version: "24.15.0",
      bunVersion: null,
      execPath: "/opt/node/bin/node",
    });
  });

  it("checks an inherited node_modules/.bin entry after Bun's prefix", () => {
    const candidates: string[] = [];
    const runtime = probePackageCliNodeRuntime({
      cwd: "/work/openclaw",
      pathEnv: [
        "/work/openclaw/node_modules/.bin",
        "/work/node_modules/.bin",
        "/node_modules/.bin",
        "/opt/tools/node_modules/.bin",
        "/opt/node/bin",
      ].join(":"),
      platform: "linux",
      run: (command) => {
        candidates.push(command);
        return {
          status: 0,
          stdout: JSON.stringify({
            version: "24.14.1",
            bunVersion: null,
            execPath: command,
          }),
        };
      },
    });

    expect(candidates).toEqual(["/opt/tools/node_modules/.bin/node"]);
    expect(runtime?.version).toBe("24.14.1");
  });

  it("checks a duplicate lifecycle-looking entry inherited in the original PATH", () => {
    const candidates: string[] = [];
    const runtime = probePackageCliNodeRuntime({
      cwd: "/work/openclaw",
      pathEnv: [
        "/work/openclaw/node_modules/.bin",
        "/work/node_modules/.bin",
        "/node_modules/.bin",
        "/work/openclaw/node_modules/.bin",
        "/opt/node/bin",
      ].join(":"),
      platform: "linux",
      run: (command) => {
        candidates.push(command);
        return {
          status: 0,
          stdout: JSON.stringify({
            version: "24.14.1",
            bunVersion: null,
            execPath: command,
          }),
        };
      },
    });

    expect(candidates).toEqual(["/work/openclaw/node_modules/.bin/node"]);
    expect(runtime?.version).toBe("24.14.1");
  });

  it("fails closed when Bun's lifecycle PATH prefix cannot be proven", () => {
    const run = vi.fn();
    expect(
      probePackageCliNodeRuntime({
        cwd: "/work/openclaw",
        pathEnv: ["/unproven/node_modules/.bin", "/opt/node/bin"].join(":"),
        platform: "linux",
        run,
      }),
    ).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed on a Bun-backed candidate from the original PATH", () => {
    const candidates: string[] = [];
    expect(
      probePackageCliNodeRuntime({
        cwd: "/work/openclaw",
        pathEnv: [
          "/work/openclaw/node_modules/.bin",
          "/work/node_modules/.bin",
          "/node_modules/.bin",
          "/opt/bun-wrapper",
          "/opt/node/bin",
        ].join(":"),
        platform: "linux",
        run: (command) => {
          candidates.push(command);
          return {
            status: 0,
            stdout: JSON.stringify({
              version: "24.15.0",
              bunVersion: "1.3.14",
              execPath: "/opt/bun/bin/bun",
            }),
          };
        },
      }),
    ).toBeNull();
    expect(candidates).toEqual(["/opt/bun-wrapper/node"]);
  });

  it.each(["", ".", "relative/bin"])(
    "fails closed before a relative PATH component %j",
    (relativeEntry) => {
      const run = vi.fn();
      expect(
        probePackageCliNodeRuntime({
          cwd: "/work/openclaw",
          pathEnv: [
            "/work/openclaw/node_modules/.bin",
            "/work/node_modules/.bin",
            "/node_modules/.bin",
            relativeEntry,
            "/opt/node/bin",
          ].join(":"),
          platform: "linux",
          run,
        }),
      ).toBeNull();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(["\\tools", "/tools"])(
    "fails closed before a Windows root-relative PATH component %j",
    (relativeEntry) => {
      const run = vi.fn();
      expect(
        probePackageCliNodeRuntime({
          cwd: "C:\\work\\openclaw",
          pathEnv: [
            "C:\\work\\openclaw\\node_modules\\.bin",
            "C:\\work\\node_modules\\.bin",
            "C:\\node_modules\\.bin",
            relativeEntry,
            "C:\\node",
          ].join(";"),
          platform: "win32",
          run,
        }),
      ).toBeNull();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("removes NODE_OPTIONS case-insensitively from a Windows probe", () => {
    let childEnv: NodeJS.ProcessEnv | undefined;
    expect(
      probePackageCliNodeRuntime({
        cwd: "C:\\work\\openclaw",
        env: {
          PATH: [
            "C:\\work\\openclaw\\node_modules\\.bin",
            "C:\\work\\node_modules\\.bin",
            "C:\\node_modules\\.bin",
            "C:\\node",
          ].join(";"),
          NODE_OPTIONS: "--require=first.cjs",
          Node_Options: "--require=second.cjs",
          OPENCLAW_PROBE_SENTINEL: "preserved",
        },
        platform: "win32",
        run: (_command, _args, options) => {
          childEnv = options.env;
          return {
            status: 0,
            stdout: JSON.stringify({
              version: "24.15.0",
              bunVersion: null,
              execPath: "C:\\node\\node.exe",
            }),
          };
        },
      }),
    ).toEqual({
      version: "24.15.0",
      bunVersion: null,
      execPath: "C:\\node\\node.exe",
    });
    expect(childEnv).toEqual({
      PATH: [
        "C:\\work\\openclaw\\node_modules\\.bin",
        "C:\\work\\node_modules\\.bin",
        "C:\\node_modules\\.bin",
        "C:\\node",
      ].join(";"),
      OPENCLAW_PROBE_SENTINEL: "preserved",
    });
  });

  it("removes the install guard after runtime validation", () => {
    const markerUrl = new URL("file:///tmp/openclaw-install-guard");
    const remove = vi.fn();
    const reportError = vi.fn();

    expect(completePackageInstallGuard({ markerUrl, remove }, reportError)).toBe(true);
    expect(remove).toHaveBeenCalledWith(markerUrl, { force: true });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fails installation when the install guard cannot be removed", () => {
    const reportError = vi.fn();
    expect(
      completePackageInstallGuard(
        {
          remove: () => {
            throw new Error("read-only package");
          },
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("could not complete package preinstall: read-only package"),
    );
  });
});

describe("detectLifecyclePackageManager", () => {
  it("prefers npm_config_user_agent when present", () => {
    expect(
      detectLifecyclePackageManager({
        npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
      }),
    ).toBe("npm");
  });

  it("falls back to npm_execpath when user agent is missing", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/Users/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
      }),
    ).toBe("pnpm");
  });

  it("detects npm cli launchers from npm_execpath", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "C:\\Tools\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      }),
    ).toBe("npm");
  });

  it("detects yarnpkg launchers from npm_execpath", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "C:\\Tools\\corepack\\yarnpkg.cmd",
      }),
    ).toBe("yarn");
  });

  it("detects versioned Yarn release launchers from npm_execpath", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/work/project/.yarn/releases/yarn-4.5.0.cjs",
      }),
    ).toBe("yarn");
  });

  it("detects Yarn Berry release launchers from npm_execpath", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/work/project/.yarn/releases/yarn-berry.cjs",
      }),
    ).toBe("yarn");
  });

  it("ignores package manager names in npm_execpath parent directories", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/tmp/npm-cache/bin/yarn.js",
      }),
    ).toBe("yarn");
  });

  it("ignores untrusted user-agent tokens with control characters", () => {
    expect(
      detectLifecyclePackageManager({
        npm_config_user_agent: "\u001bnpm/11.4.1 node/v22.20.0 darwin arm64",
        npm_execpath: "/Users/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
      }),
    ).toBe("pnpm");
  });
});

describe("createPackageManagerWarningMessage", () => {
  it("returns null for pnpm", () => {
    expect(createPackageManagerWarningMessage("pnpm")).toBeNull();
  });

  it("warns for npm installs", () => {
    expect(createPackageManagerWarningMessage("npm")).toContain("prefer: corepack pnpm install");
  });
});

describe("warnIfNonPnpmLifecycle", () => {
  it("warns once for npm lifecycle runs", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
        },
        warn,
      ),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(requireFirstWarning(warn)).toContain("detected npm");
  });

  it("stays quiet for pnpm", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "pnpm/10.32.1 npm/? node/v22.20.0 darwin arm64",
        },
        warn,
      ),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
