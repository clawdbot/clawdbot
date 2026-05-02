import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveBundledPluginsDir,
  resolveSourceCheckoutDependencyDiagnostic,
} from "./bundled-dir.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const originalVitest = process.env.VITEST;
const originalArgv1 = process.argv[1];
const originalExecArgv = [...process.execArgv];

function makeRepoRoot(prefix: string): string {
  return makeTrackedTempDir(prefix, tempDirs);
}

function createOpenClawRoot(params: {
  prefix: string;
  hasExtensions?: boolean;
  hasSrc?: boolean;
  hasDistRuntimeExtensions?: boolean;
  hasDistExtensions?: boolean;
  hasGitCheckout?: boolean;
  hasPnpmWorkspace?: boolean;
}) {
  const repoRoot = makeRepoRoot(params.prefix);
  if (params.hasExtensions) {
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
  }
  if (params.hasSrc) {
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  }
  if (params.hasDistRuntimeExtensions) {
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions"), { recursive: true });
  }
  if (params.hasDistExtensions) {
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
  }
  if (params.hasGitCheckout) {
    fs.writeFileSync(path.join(repoRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf8");
  }
  if (params.hasPnpmWorkspace) {
    fs.writeFileSync(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      "packages:\n  - .\n  - extensions/*\n",
      "utf8",
    );
  }
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
    "utf8",
  );
  return repoRoot;
}

function seedBundledPluginTree(rootDir: string, relativeDir: string, pluginId = "discord") {
  const pluginDir = path.join(rootDir, relativeDir, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({ name: `@openclaw/${pluginId}` }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId }, null, 2)}\n`,
    "utf8",
  );
}

function expectResolvedBundledDir(params: {
  cwd: string;
  expectedDir: string;
  argv1?: string;
  bundledDirOverride?: string;
  disableBundledPlugins?: string;
  vitest?: string;
  execArgv?: readonly string[];
}) {
  vi.spyOn(process, "cwd").mockReturnValue(params.cwd);
  process.argv[1] = params.argv1 ?? "/usr/bin/env";
  process.execArgv.length = 0;
  process.execArgv.push(...(params.execArgv ?? []));
  if (params.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = params.vitest;
  }
  if (params.bundledDirOverride === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = params.bundledDirOverride;
  }
  if (params.disableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = params.disableBundledPlugins;
  }

  expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
    fs.realpathSync(params.expectedDir),
  );
}

function expectResolvedBundledDirFromRoot(params: {
  repoRoot: string;
  expectedRelativeDir: string;
  argv1?: string;
  bundledDirOverride?: string;
  vitest?: string;
  cwd?: string;
  execArgv?: readonly string[];
}) {
  expectResolvedBundledDir({
    cwd: params.cwd ?? params.repoRoot,
    expectedDir: path.join(params.repoRoot, params.expectedRelativeDir),
    argv1: params.argv1 ?? path.join(params.repoRoot, "openclaw.mjs"),
    ...(params.bundledDirOverride ? { bundledDirOverride: params.bundledDirOverride } : {}),
    ...(params.vitest !== undefined ? { vitest: params.vitest } : {}),
    ...(params.execArgv ? { execArgv: params.execArgv } : {}),
  });
}

function expectInstalledBundledDirScenario(params: {
  installedRoot: string;
  cwd?: string;
  argv1?: string;
  bundledDirOverride?: string;
}) {
  expectResolvedBundledDirFromRoot({
    repoRoot: params.installedRoot,
    cwd: params.cwd ?? process.cwd(),
    ...(params.argv1 ? { argv1: params.argv1 } : {}),
    ...(params.bundledDirOverride ? { bundledDirOverride: params.bundledDirOverride } : {}),
    expectedRelativeDir: path.join("dist", "extensions"),
  });
}

function expectInstalledBundledDirScenarioCase(
  createScenario: () => {
    installedRoot: string;
    cwd?: string;
    argv1?: string;
    bundledDirOverride?: string;
  },
) {
  expectInstalledBundledDirScenario(createScenario());
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBundledDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
  if (originalVitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitest;
  }
  process.argv[1] = originalArgv1;
  process.execArgv.length = 0;
  process.execArgv.push(...originalExecArgv);
  cleanupTrackedTempDirs(tempDirs);
});

describe("resolveBundledPluginsDir", () => {
  it.each([
    [
      "prefers the runtime bundled plugin tree from the package root",
      {
        prefix: "openclaw-bundled-dir-runtime-",
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist-runtime", "extensions"),
      },
    ],
    [
      "falls back to built dist/extensions in installed package roots",
      {
        prefix: "openclaw-bundled-dir-dist-",
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist", "extensions"),
      },
    ],
    [
      "prefers source extensions in a pnpm git checkout outside vitest",
      {
        prefix: "openclaw-bundled-dir-git-built-",
        hasExtensions: true,
        hasSrc: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: "extensions",
      },
    ],
    [
      "does not prefer source extensions from VITEST alone",
      {
        prefix: "openclaw-bundled-dir-vitest-",
        hasExtensions: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist-runtime", "extensions"),
        vitest: "true",
      },
    ],
    [
      "still prefers source extensions during tsx-driven pnpm source execution",
      {
        prefix: "openclaw-bundled-dir-tsx-built-",
        hasExtensions: true,
        hasSrc: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: "extensions",
        execArgv: ["--import", "tsx"],
      },
    ],
    [
      "uses source extensions in a pnpm git checkout when built trees are missing",
      {
        prefix: "openclaw-bundled-dir-git-",
        hasExtensions: true,
        hasSrc: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: "extensions",
      },
    ],
  ] as const)("%s", (_name, layout, expectation) => {
    const repoRoot = createOpenClawRoot(layout);
    if (expectation.expectedRelativeDir === path.join("dist-runtime", "extensions")) {
      seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
      seedBundledPluginTree(repoRoot, path.join("dist-runtime", "extensions"));
    } else if (expectation.expectedRelativeDir === path.join("dist", "extensions")) {
      seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
    } else if (expectation.expectedRelativeDir === "extensions") {
      seedBundledPluginTree(repoRoot, "extensions");
    }
    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: expectation.expectedRelativeDir,
      ...("vitest" in expectation ? { vitest: expectation.vitest } : {}),
      ...("execArgv" in expectation ? { execArgv: [...expectation.execArgv] } : {}),
    });
  });

  it("falls back to source extensions when dist trees exist but do not contain real plugin manifests", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-incomplete-built-",
      hasExtensions: true,
      hasSrc: true,
      hasDistRuntimeExtensions: true,
      hasDistExtensions: true,
      hasGitCheckout: true,
      hasPnpmWorkspace: true,
    });
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions", "discord"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions", "discord"), {
      recursive: true,
    });
    seedBundledPluginTree(repoRoot, "extensions");

    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: "extensions",
    });
  });

  it("keeps built bundled plugins for git-looking trees without pnpm workspace metadata", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-git-no-pnpm-",
      hasExtensions: true,
      hasSrc: true,
      hasDistRuntimeExtensions: true,
      hasDistExtensions: true,
      hasGitCheckout: true,
    });
    seedBundledPluginTree(repoRoot, "extensions");
    seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
    seedBundledPluginTree(repoRoot, path.join("dist-runtime", "extensions"));

    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: path.join("dist-runtime", "extensions"),
    });
  });

  it("reports missing pnpm workspace deps for source checkouts", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-source-deps-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
      hasPnpmWorkspace: true,
    });
    seedBundledPluginTree(repoRoot, "extensions", "twitch");
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    process.argv[1] = path.join(repoRoot, "openclaw.mjs");

    expect(resolveSourceCheckoutDependencyDiagnostic()).toEqual({
      source: repoRoot,
      message: expect.stringContaining("run `pnpm install`"),
    });

    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    expect(resolveSourceCheckoutDependencyDiagnostic()).toBeNull();

    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    fs.mkdirSync(path.join(repoRoot, "node_modules", ".pnpm"), { recursive: true });
    expect(resolveSourceCheckoutDependencyDiagnostic()).toBeNull();
  });

  it("returns a stable empty bundled plugin directory when bundled plugins are disabled", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-disabled-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    process.argv[1] = "/usr/bin/env";
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    const bundledDir = resolveBundledPluginsDir();

    expect(bundledDir).toBeTruthy();
    expect(fs.existsSync(bundledDir ?? "")).toBe(true);
    expect(fs.readdirSync(bundledDir ?? "")).toEqual([]);
  });

  it("ignores an existing override under an argv1-derived fake package root", () => {
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-argv-override-reject-",
      hasDistExtensions: true,
    });
    seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));

    vi.spyOn(process, "cwd").mockReturnValue(installedRoot);
    process.argv[1] = path.join(installedRoot, "openclaw.mjs");
    process.execArgv.length = 0;
    delete process.env.VITEST;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(installedRoot, "dist", "extensions");
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = resolveBundledPluginsDir();

    expect(bundledDir).toBeDefined();
    expect(fs.realpathSync(bundledDir!)).not.toBe(
      fs.realpathSync(path.join(installedRoot, "dist", "extensions")),
    );
  });

  it("does not let VITEST relax existing override trust checks", () => {
    const overrideRoot = makeRepoRoot("openclaw-bundled-dir-vitest-override-reject-");
    seedBundledPluginTree(overrideRoot, "extensions", "memory-core");

    vi.spyOn(process, "cwd").mockReturnValue(overrideRoot);
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    process.env.VITEST = "true";
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(overrideRoot, "extensions");
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = resolveBundledPluginsDir();

    expect(bundledDir).toBeDefined();
    expect(fs.realpathSync(bundledDir!)).not.toBe(
      fs.realpathSync(path.join(overrideRoot, "extensions")),
    );
  });

  it("does not let VITEST add cwd to bundled plugin resolution candidates", () => {
    const cwdRepoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-vitest-cwd-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    seedBundledPluginTree(cwdRepoRoot, "extensions", "memory-core");

    vi.spyOn(process, "cwd").mockReturnValue(cwdRepoRoot);
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    process.env.VITEST = "true";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = resolveBundledPluginsDir();

    expect(bundledDir).toBeDefined();
    expect(fs.realpathSync(bundledDir!)).not.toBe(
      fs.realpathSync(path.join(cwdRepoRoot, "extensions")),
    );
  });

  it("falls back from a missing override instead of returning an untrusted future path", () => {
    vi.spyOn(process, "cwd").mockReturnValue(makeRepoRoot("openclaw-bundled-dir-missing-cwd-"));
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    delete process.env.VITEST;
    const missingOverride = path.join(
      makeRepoRoot("openclaw-bundled-dir-missing-override-"),
      "extensions",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = missingOverride;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = resolveBundledPluginsDir();

    expect(bundledDir).toBeDefined();
    expect(path.resolve(bundledDir!)).not.toBe(path.resolve(missingOverride));
  });

  it("falls back to argv root when an existing rejected override is unrelated", () => {
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-rejected-override-argv-",
      hasDistExtensions: true,
    });
    seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
    const overrideRoot = makeRepoRoot("openclaw-bundled-dir-rejected-override-");
    seedBundledPluginTree(overrideRoot, "extensions", "memory-core");

    vi.spyOn(process, "cwd").mockReturnValue(makeRepoRoot("openclaw-bundled-dir-rejected-cwd-"));
    process.argv[1] = path.join(installedRoot, "openclaw.mjs");
    process.execArgv.length = 0;
    delete process.env.VITEST;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(overrideRoot, "extensions");
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = resolveBundledPluginsDir();

    expect(fs.realpathSync(bundledDir ?? "")).toBe(
      fs.realpathSync(path.join(installedRoot, "dist", "extensions")),
    );
  });

  it("does not resolve bundled plugins from cwd when argv1 is not a package root", () => {
    const cwdRepoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-untrusted-cwd-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    fs.mkdirSync(path.join(cwdRepoRoot, "extensions", "memory-core"), { recursive: true });
    fs.writeFileSync(
      path.join(cwdRepoRoot, "extensions", "memory-core", "runtime-api.js"),
      "export const marker = 'untrusted-cwd';\n",
      "utf8",
    );
    vi.spyOn(process, "cwd").mockReturnValue(cwdRepoRoot);
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    delete process.env.VITEST;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = resolveBundledPluginsDir();

    expect(bundledDir).toBeDefined();
    expect(fs.realpathSync(bundledDir!)).not.toBe(
      fs.realpathSync(path.join(cwdRepoRoot, "extensions")),
    );
  });

  it.each([
    {
      name: "prefers the running CLI package root over an unrelated cwd checkout",
      createScenario: () => {
        const installedRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-installed-",
          hasDistExtensions: true,
        });
        seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
        const cwdRepoRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-cwd-",
          hasExtensions: true,
          hasSrc: true,
          hasGitCheckout: true,
        });
        return {
          installedRoot,
          cwd: cwdRepoRoot,
          argv1: path.join(installedRoot, "openclaw.mjs"),
        };
      },
    },
    {
      name: "falls back to the running installed package when the override path is stale",
      createScenario: () => {
        const installedRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-override-",
          hasDistExtensions: true,
        });
        seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
        return {
          installedRoot,
          argv1: path.join(installedRoot, "openclaw.mjs"),
          bundledDirOverride: path.join(installedRoot, "missing-extensions"),
        };
      },
    },
  ] as const)("$name", ({ createScenario }) => {
    expectInstalledBundledDirScenarioCase(createScenario);
  });
});
