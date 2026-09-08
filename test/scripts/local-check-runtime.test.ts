// Local Check Runtime tests cover local check runtime script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalOxlintPolicy,
  applyLocalTsgoPolicy,
  ensureRepoNodeModulesLink,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "../../scripts/lib/local-check-runtime.mts";
import { resolveTsxImport } from "../../scripts/lib/tsx-cli-shim.mjs";
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

  it.each([
    { platform: "linux" as const, linkType: "dir" },
    { platform: "win32" as const, linkType: "junction" },
  ])(
    "links relocated $platform declaration output to its explicit package dependencies",
    ({ platform, linkType }) => {
      const primaryRoot = createTempDir("openclaw-primary-toolchain-");
      const cwd = path.join(primaryRoot, ".artifacts", "declarations");
      const primaryTsgo = path.join(primaryRoot, "node_modules", ".bin", "tsgo");
      const primaryNodeModules = path.join(primaryRoot, "node_modules");
      const localNodeModules = path.join(cwd, "node_modules");
      fs.mkdirSync(path.dirname(primaryTsgo), { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      const linkTypes: Array<Parameters<typeof fs.symlinkSync>[2]> = [];
      const linkOptions = {
        cwd,
        platform,
        symlink: (...args: Parameters<typeof fs.symlinkSync>) => {
          linkTypes.push(args[2]);
          fs.symlinkSync(...args);
        },
      };

      expect(ensureRepoNodeModulesLink(primaryNodeModules, linkOptions)).toBe(localNodeModules);
      expect(fs.realpathSync(localNodeModules)).toBe(fs.realpathSync(primaryNodeModules));

      // The stable link is idempotent for concurrent and later local runners.
      expect(ensureRepoNodeModulesLink(primaryNodeModules, linkOptions)).toBe(localNodeModules);
      expect(linkTypes).toEqual([linkType]);
    },
  );

  it("leaves existing worktree node_modules directories locally owned", () => {
    const primaryRoot = createTempDir("openclaw-primary-toolchain-");
    const primaryTsgo = path.join(primaryRoot, "node_modules", ".bin", "tsgo");
    const cwd = path.join(primaryRoot, "worktree");
    const localNodeModules = path.join(cwd, "node_modules");
    fs.mkdirSync(path.dirname(primaryTsgo), { recursive: true });
    fs.mkdirSync(localNodeModules, { recursive: true });

    ensureRepoNodeModulesLink(path.join(primaryRoot, "node_modules"), { cwd });

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
    { name: "small CI runner", ci: "true", cpus: 4, gib: 16, throttled: true },
    { name: "memory-constrained CI runner", ci: "true", cpus: 16, gib: 16, throttled: true },
    { name: "CPU-constrained CI runner", ci: "true", cpus: 4, gib: 32, throttled: true },
    { name: "parallel CI boundary", ci: "true", cpus: 8, gib: 24, throttled: false },
    { name: "large CI runner", ci: "true", cpus: 16, gib: 32, throttled: false },
    { name: "disabled local policy", ci: undefined, cpus: 4, gib: 16, throttled: false },
  ])("applies compiler memory policy for $name", ({ ci, cpus, gib, throttled }) => {
    const inputEnv = makeEnv({
      CI: ci,
      OPENCLAW_LOCAL_CHECK: "0",
      GOMAXPROCS: "2",
      GOGC: undefined,
      GOMEMLIMIT: undefined,
    });
    const { args, env } = applyLocalOxlintPolicy(["--threads=1"], inputEnv, {
      logicalCpuCount: cpus,
      totalMemoryBytes: gib * GIB,
    });

    expect(env.GOMAXPROCS).toBe("2");
    expect(env.GOGC).toBe(throttled ? "30" : undefined);
    expect(env.GOMEMLIMIT).toBe(throttled ? "3GiB" : undefined);
    expect(inputEnv.GOGC).toBeUndefined();
    expect(inputEnv.GOMEMLIMIT).toBeUndefined();
    expect(args.filter((arg) => arg.startsWith("--threads"))).toEqual(["--threads=1"]);
    expect(args).toContain("--type-aware");
  });

  it("preserves explicit compiler limits on constrained GitHub Actions runners", () => {
    const { args, env } = applyLocalOxlintPolicy(
      ["--threads=3"],
      makeEnv({
        CI: undefined,
        GITHUB_ACTIONS: "true",
        OPENCLAW_LOCAL_CHECK: "0",
        GOMAXPROCS: "3",
        GOGC: "80",
        GOMEMLIMIT: "5GiB",
      }),
      { logicalCpuCount: 4, totalMemoryBytes: 16 * GIB },
    );
    expect(env.GOMAXPROCS).toBe("3");
    expect(env.GOGC).toBe("80");
    expect(env.GOMEMLIMIT).toBe("5GiB");
    expect(args.filter((arg) => arg.startsWith("--threads"))).toEqual(["--threads=3"]);
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
        [path.resolve("scripts/run-oxlint.mjs"), "--tsconfig", "extensions/tsconfig.json"],
        { cwd, encoding: "utf8", env },
      );

      expect(result.status, result.stderr).toBe(0);
      const children = fs
        .readFileSync(capturePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(children).toEqual([
        { step: "prep", goEnv: prepGoEnv, args: ["--mode=package-boundary"] },
        {
          step: "lint",
          goEnv: lintGoEnv,
          args: [
            "--tsconfig",
            "extensions/tsconfig.json",
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

describe("TypeScript bootstrap dependency ownership", () => {
  afterEach(() => vi.unstubAllEnvs());

  function fixture() {
    vi.stubEnv("PNPM_CONFIG_MODULES_DIR", undefined);
    vi.stubEnv("pnpm_config_modules_dir", undefined);
    vi.stubEnv("npm_config_modules_dir", undefined);
    const root = fs.realpathSync(createTempDir("openclaw-toolchain-ownership-"));
    const primary = path.join(root, "primary");
    const checkout = path.join(root, "checkout");
    fs.mkdirSync(checkout);
    expect(spawnSync("git", ["init", "--quiet", primary]).status).toBe(0);
    const gitdir = path.join(primary, ".git", "worktrees", "task");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(gitdir, "gitdir"), `${checkout}/.git\n`);
    fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${gitdir}\n`);
    const modules = path.join(primary, "node_modules");
    const tsx = path.join(modules, "tsx");
    fs.mkdirSync(tsx, { recursive: true });
    fs.writeFileSync(
      path.join(tsx, "package.json"),
      JSON.stringify({ name: "tsx", type: "module", exports: { "./esm": "./esm.mjs" } }),
    );
    fs.writeFileSync(path.join(tsx, "esm.mjs"), "export {};\n");
    return { checkout, modules, entry: pathToFileURL(path.join(tsx, "esm.mjs")).href };
  }

  it.each([false, true])(
    "refuses a missing worktree install with an empty override=%s",
    (emptyOverride) => {
      const { checkout, modules } = fixture();
      if (emptyOverride) {
        vi.stubEnv("PNPM_CONFIG_MODULES_DIR", "");
        vi.stubEnv("pnpm_config_modules_dir", modules);
      }
      const before = fs.statSync(modules);
      expect(() => resolveTsxImport(checkout)).toThrow("pnpm install --frozen-lockfile");
      expect(fs.existsSync(path.join(checkout, "node_modules"))).toBe(false);
      expect(fs.statSync(modules).ino).toBe(before.ino);
      expect(fs.statSync(modules).mtimeMs).toBe(before.mtimeMs);
    },
  );

  it("keeps an existing explicit borrow readable without replacing its link", () => {
    const { checkout, modules, entry } = fixture();
    const link = path.join(checkout, "node_modules");
    fs.symlinkSync(modules, link, process.platform === "win32" ? "junction" : "dir");
    const before = fs.lstatSync(link);
    const target = fs.readlinkSync(link);
    expect(resolveTsxImport(checkout)).toBe(entry);
    expect(fs.lstatSync(link).ino).toBe(before.ino);
    expect(fs.readlinkSync(link)).toBe(target);
  });

  it("uses owned checkout dependencies when the configured directory contains only metadata", () => {
    const { checkout, modules } = fixture();
    const localModules = path.join(checkout, "node_modules");
    fs.cpSync(modules, localModules, { recursive: true });
    const metadata = path.join(path.dirname(checkout), "metadata");
    fs.mkdirSync(metadata);
    fs.writeFileSync(path.join(metadata, ".modules.yaml"), "virtualStoreDir: .pnpm\n");
    vi.stubEnv("PNPM_CONFIG_MODULES_DIR", metadata);
    const before = fs.lstatSync(localModules);
    expect(resolveTsxImport(checkout)).toBe(
      pathToFileURL(path.join(localModules, "tsx", "esm.mjs")).href,
    );
    expect(fs.lstatSync(localModules).ino).toBe(before.ino);
    expect(fs.lstatSync(localModules).isSymbolicLink()).toBe(false);
  });

  it.each(["PNPM_CONFIG_MODULES_DIR", "pnpm_config_modules_dir", "npm_config_modules_dir"])(
    "preserves the explicitly configured hydrated toolchain through %s",
    (key) => {
      const { checkout, modules, entry } = fixture();
      vi.stubEnv(key, modules);
      expect(resolveTsxImport(checkout)).toBe(entry);
      expect(fs.realpathSync(path.join(checkout, "node_modules"))).toBe(modules);
    },
  );

  it("preserves leading whitespace in an explicitly configured module directory", () => {
    const { checkout, modules } = fixture();
    const configured = " modules";
    const target = path.join(checkout, configured);
    fs.renameSync(modules, target);
    vi.stubEnv("PNPM_CONFIG_MODULES_DIR", configured);
    expect(resolveTsxImport(checkout)).toBe(
      pathToFileURL(path.join(target, "tsx", "esm.mjs")).href,
    );
    expect(fs.realpathSync(path.join(checkout, "node_modules"))).toBe(target);
  });
});
