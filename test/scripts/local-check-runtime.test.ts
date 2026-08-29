// Local Check Runtime tests cover local check runtime script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyLocalOxlintPolicy,
  applyLocalTsgoPolicy,
  ensureRepoToolNodeModulesLink,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "../../scripts/lib/local-check-runtime.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const GIB = 1024 ** 3;
const CONSTRAINED_HOST = {
  totalMemoryBytes: 16 * GIB,
  logicalCpuCount: 8,
};
const ROOMY_HOST = {
  totalMemoryBytes: 128 * GIB,
  logicalCpuCount: 16,
};

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_LOCAL_CHECK: "1",
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "OPENCLAW_LOCAL_CHECK_MODE")) {
    delete env.OPENCLAW_LOCAL_CHECK_MODE;
  }
  if (!Object.hasOwn(overrides, "GITHUB_ACTIONS")) {
    delete env.GITHUB_ACTIONS;
  }
  return env;
}

describe("local-check-runtime", () => {
  it("resolves repo tools from the primary checkout for dependency-less worktrees", () => {
    const primaryRoot = createTempDir("openclaw-primary-checkout-");
    const cwd = path.join(primaryRoot, ".codex", "worktrees", "task", "openclaw");
    const commonDir = path.join(primaryRoot, ".git");
    const localPath = path.resolve(cwd, "node_modules", ".bin", "oxlint");
    const primaryPath = path.join(primaryRoot, "node_modules", ".bin", "oxlint");

    expect(
      resolveRepoToolBinPath("oxlint", {
        cwd,
        fileExists: (candidate) => candidate === primaryPath,
        resolveCommonDir: () => commonDir,
      }),
    ).toBe(primaryPath);
    expect(
      resolveRepoToolBinPath("oxlint", {
        cwd,
        fileExists: (candidate) => candidate === localPath || candidate === primaryPath,
        resolveCommonDir: () => commonDir,
      }),
    ).toBe(localPath);
  });

  it("links dependency-less worktrees to the selected checkout's modules", () => {
    const primaryRoot = createTempDir("openclaw-primary-toolchain-");
    const cwd = path.join(primaryRoot, ".codex", "worktrees", "task", "openclaw");
    const commonDir = path.join(primaryRoot, ".git");
    const primaryTsgo = path.join(primaryRoot, "node_modules", ".bin", "tsgo");
    const primaryNodeModules = path.join(primaryRoot, "node_modules");
    const localNodeModules = path.join(cwd, "node_modules");
    fs.mkdirSync(path.dirname(primaryTsgo), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    expect(
      ensureRepoToolNodeModulesLink(primaryTsgo, {
        cwd,
        resolveCommonDir: () => commonDir,
      }),
    ).toBe(localNodeModules);
    expect(fs.realpathSync(localNodeModules)).toBe(fs.realpathSync(primaryNodeModules));

    // The stable link is idempotent for concurrent and later local runners.
    expect(
      ensureRepoToolNodeModulesLink(primaryTsgo, {
        cwd,
        resolveCommonDir: () => commonDir,
      }),
    ).toBe(localNodeModules);
  });

  it("leaves existing worktree node_modules directories locally owned", () => {
    const primaryRoot = createTempDir("openclaw-primary-toolchain-");
    const commonDir = path.join(primaryRoot, ".git");
    const primaryTsgo = path.join(primaryRoot, "node_modules", ".bin", "tsgo");
    const cwd = path.join(primaryRoot, "worktree");
    const localNodeModules = path.join(cwd, "node_modules");
    fs.mkdirSync(path.dirname(primaryTsgo), { recursive: true });
    fs.mkdirSync(localNodeModules, { recursive: true });

    ensureRepoToolNodeModulesLink(primaryTsgo, {
      cwd,
      resolveCommonDir: () => commonDir,
    });

    expect(fs.lstatSync(localNodeModules).isDirectory()).toBe(true);
    expect(fs.lstatSync(localNodeModules).isSymbolicLink()).toBe(false);
  });

  it("reenables local check policy for local wrapper entrypoints", () => {
    expect(resolveLocalCheckEnv({ OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" })).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
    expect(resolveLocalCheckEnv({ OPENCLAW_LOCAL_CHECK: "false", PATH: "/usr/bin" })).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
  });

  it("preserves local-check disablement in CI", () => {
    expect(
      resolveLocalCheckEnv({
        CI: "true",
        OPENCLAW_LOCAL_CHECK: "0",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      CI: "true",
      OPENCLAW_LOCAL_CHECK: "0",
      PATH: "/usr/bin",
    });
  });

  it("tightens local tsgo runs on constrained hosts", () => {
    const { args, env } = applyLocalTsgoPolicy([], makeEnv(), CONSTRAINED_HOST);

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/root.tsbuildinfo",
      "--singleThreaded",
      "--checkers",
      "1",
    ]);
    expect(env.GOMAXPROCS).toBe("2");
    expect(env.GOGC).toBe("30");
    expect(env.GOMEMLIMIT).toBe("3GiB");
  });

  it("skips declaration transforms for no-emit tsgo checks", () => {
    const { args } = applyLocalTsgoPolicy([], makeEnv({ OPENCLAW_LOCAL_CHECK: "0" }), ROOMY_HOST);

    expect(args).toEqual(["--declaration", "false"]);
  });

  it("keeps explicit tsgo flags and Go env overrides intact when throttled", () => {
    const { args, env } = applyLocalTsgoPolicy(
      ["--checkers", "4", "--singleThreaded", "--pprofDir", "/tmp/existing"],
      makeEnv({
        GOMAXPROCS: "3",
        GOGC: "80",
        GOMEMLIMIT: "5GiB",
        OPENCLAW_TSGO_PPROF_DIR: "/tmp/profile",
      }),
      CONSTRAINED_HOST,
    );

    expect(args).toEqual([
      "--checkers",
      "4",
      "--singleThreaded",
      "--pprofDir",
      "/tmp/existing",
      "--declaration",
      "false",
    ]);
    expect(env.GOMAXPROCS).toBe("3");
    expect(env.GOGC).toBe("80");
    expect(env.GOMEMLIMIT).toBe("5GiB");
  });

  it("keeps explicit tsgo declaration flags intact", () => {
    const env = makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "full" });
    const longFlag = applyLocalTsgoPolicy(["--declaration"], env, ROOMY_HOST);
    const shortFlag = applyLocalTsgoPolicy(["-d"], env, ROOMY_HOST);

    expect(longFlag.args).toEqual(["--declaration"]);
    expect(shortFlag.args).toEqual(["-d"]);
  });

  it("defaults local tsgo to full-speed mode on roomy hosts", () => {
    const { args, env } = applyLocalTsgoPolicy([], makeEnv(), ROOMY_HOST);

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/root.tsbuildinfo",
    ]);
    expect(env.GOMAXPROCS).toBeUndefined();
    expect(env.GOGC).toBeUndefined();
    expect(env.GOMEMLIMIT).toBeUndefined();
  });

  it("uses the configured local tsgo build info file", () => {
    const { args } = applyLocalTsgoPolicy(
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "full",
        OPENCLAW_TSGO_BUILD_INFO_FILE: ".artifacts/custom/tsgo.tsbuildinfo",
      }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/custom/tsgo.tsbuildinfo",
    ]);
  });

  it("avoids incremental cache reuse for ad hoc tsgo runs", () => {
    const { args } = applyLocalTsgoPolicy(
      ["--extendedDiagnostics"],
      makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "full" }),
      ROOMY_HOST,
    );

    expect(args).toEqual(["--extendedDiagnostics", "--declaration", "false"]);
  });

  it("allows forcing the throttled tsgo policy on roomy hosts", () => {
    const { args, env } = applyLocalTsgoPolicy(
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "throttled",
      }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/root.tsbuildinfo",
      "--singleThreaded",
      "--checkers",
      "1",
    ]);
    expect(env.GOMAXPROCS).toBe("2");
    expect(env.GOGC).toBe("30");
    expect(env.GOMEMLIMIT).toBe("3GiB");
  });

  it("does not oversubscribe a single-CPU host", () => {
    const { env } = applyLocalTsgoPolicy([], makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "throttled" }), {
      logicalCpuCount: 1,
      totalMemoryBytes: 16 * 1024 ** 3,
    });

    expect(env.GOMAXPROCS).toBe("1");
  });

  it("allows forcing full-speed tsgo runs on roomy hosts", () => {
    const { args, env } = applyLocalTsgoPolicy(
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "full",
      }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/root.tsbuildinfo",
    ]);
    expect(env.GOMAXPROCS).toBeUndefined();
    expect(env.GOGC).toBeUndefined();
    expect(env.GOMEMLIMIT).toBeUndefined();
  });

  it("serializes local oxlint runs onto one thread on constrained hosts", () => {
    const { args, env } = applyLocalOxlintPolicy([], makeEnv(), CONSTRAINED_HOST);

    expect(args).toEqual([
      "--type-aware",
      "--tsconfig",
      "config/tsconfig/oxlint.json",
      "--report-unused-disable-directives-severity",
      "error",
      "--threads=1",
    ]);
    expect(env.GOMAXPROCS).toBe("2");
    expect(env.GOGC).toBe("30");
    expect(env.GOMEMLIMIT).toBe("3GiB");
  });

  it("defaults local oxlint to one thread on roomy hosts", () => {
    const { args, env } = applyLocalOxlintPolicy([], makeEnv(), ROOMY_HOST);

    expect(args).toEqual([
      "--type-aware",
      "--tsconfig",
      "config/tsconfig/oxlint.json",
      "--report-unused-disable-directives-severity",
      "error",
      "--threads=1",
    ]);
    expect(env.GOMAXPROCS).toBe("2");
    expect(env.GOGC).toBe("30");
    expect(env.GOMEMLIMIT).toBe("3GiB");
  });

  it("honors an explicit oxlint thread count", () => {
    const { args, env } = applyLocalOxlintPolicy(
      ["--threads=8"],
      makeEnv({ GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--threads=8",
      "--type-aware",
      "--tsconfig",
      "config/tsconfig/oxlint.json",
      "--report-unused-disable-directives-severity",
      "error",
    ]);
    expect(env.GOMAXPROCS).toBe("3");
    expect(env.GOGC).toBe("80");
    expect(env.GOMEMLIMIT).toBe("5GiB");
  });

  it.each([
    {
      name: "default Go settings",
      goEnv: { GOMAXPROCS: undefined, GOGC: undefined, GOMEMLIMIT: undefined },
      prepGoEnv: { GOMAXPROCS: null, GOGC: null, GOMEMLIMIT: null },
      lintGoEnv: {
        GOMAXPROCS: String(Math.min(2, Math.max(1, os.availableParallelism()))),
        GOGC: "30",
        GOMEMLIMIT: "3GiB",
      },
    },
    {
      name: "explicit user Go settings",
      goEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
      prepGoEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
      lintGoEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
    },
  ])(
    "keeps prep and oxlint resource policies separate with $name",
    ({ goEnv, prepGoEnv, lintGoEnv }) => {
      const cwd = createTempDir("openclaw-oxlint-go-limit-");
      const binDir = path.join(cwd, "node_modules", ".bin");
      const scriptsDir = path.join(cwd, "scripts");
      const capturePath = path.join(cwd, "children.jsonl");
      const oxlintPath = path.join(binDir, "oxlint");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(scriptsDir, { recursive: true });
      const captureSource = `
const goEnv = Object.fromEntries(["GOMAXPROCS", "GOGC", "GOMEMLIMIT"].map(key => [key, process.env[key] ?? null]));
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({ step, goEnv, args: process.argv.slice(2) }) + "\\n");
`;
      fs.writeFileSync(
        path.join(scriptsDir, "prepare-extension-package-boundary-artifacts.mts"),
        `import fs from "node:fs";\nconst step = "prep";\n${captureSource}`,
        "utf8",
      );
      fs.writeFileSync(
        oxlintPath,
        `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst step = "lint";\n${captureSource}`,
        "utf8",
      );
      fs.chmodSync(oxlintPath, 0o755);
      const env = makeEnv({
        CAPTURE_PATH: capturePath,
        OPENCLAW_OXLINT_SKIP_PREPARE: undefined,
        ...goEnv,
      });

      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/run-oxlint.mjs"),
          "--tsconfig",
          "config/tsconfig/oxlint.extensions.json",
        ],
        { cwd, encoding: "utf8", env },
      );

      expect(result.status, result.stderr).toBe(0);
      const children = fs
        .readFileSync(capturePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(children).toEqual([
        { step: "prep", goEnv: prepGoEnv, args: [] },
        {
          step: "lint",
          goEnv: lintGoEnv,
          args: [
            "--tsconfig",
            "config/tsconfig/oxlint.extensions.json",
            "--type-aware",
            "--report-unused-disable-directives-severity",
            "error",
            "--threads=1",
          ],
        },
      ]);
    },
  );

  it("allows forcing full-speed oxlint runs on roomy hosts", () => {
    const { args, env } = applyLocalOxlintPolicy(
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "full",
      }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--type-aware",
      "--tsconfig",
      "config/tsconfig/oxlint.json",
      "--report-unused-disable-directives-severity",
      "error",
    ]);
    expect(env.GOGC).toBeUndefined();
    expect(env.GOMEMLIMIT).toBeUndefined();
  });

  it("uses stylish oxlint output in GitHub Actions before the command separator", () => {
    const { args } = applyLocalOxlintPolicy(
      ["--", "src/example.ts"],
      makeEnv({
        GITHUB_ACTIONS: "true",
        OPENCLAW_LOCAL_CHECK_MODE: "full",
      }),
      ROOMY_HOST,
    );

    expect(args.slice(-4)).toEqual(["--format", "stylish", "--", "src/example.ts"]);
  });

  it.each(["--format", "--format=json", "-f", "-f=json", "-fjson"])(
    "preserves an explicit oxlint format argument: %s",
    (formatArg) => {
      const { args } = applyLocalOxlintPolicy(
        [formatArg],
        makeEnv({
          GITHUB_ACTIONS: "true",
          OPENCLAW_LOCAL_CHECK_MODE: "full",
        }),
        ROOMY_HOST,
      );

      expect(args).not.toContain("stylish");
    },
  );
});
