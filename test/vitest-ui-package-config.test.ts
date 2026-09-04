// Vitest UI package config tests validate UI package test project settings.
import { globSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import uiConfig from "../ui/vitest.config.ts";
import uiNodeConfig from "../ui/vitest.node.config.ts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { normalizeConfigPath } from "./helpers/vitest-config-paths.js";
import { loadVitestExperimentalConfig } from "./vitest/vitest.performance-config.ts";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";

type ExpectedTestConfig = {
  clearMocks?: boolean;
  experimental?: ReturnType<typeof loadVitestExperimentalConfig>["experimental"];
  include?: string[];
  exclude?: string[];
  browser?: { enabled?: boolean };
  isolate?: boolean;
  name?: string;
  maxWorkers?: number;
  pool?: string;
  projects?: unknown[];
  runner?: string;
};

function requireTestConfig(config: unknown): ExpectedTestConfig {
  if (!config || typeof config !== "object" || !("test" in config) || !config.test) {
    throw new Error("expected ui package vitest test config");
  }
  return config.test as ExpectedTestConfig;
}

function requireAlias(config: unknown, specifier: string): { find: string; replacement: string } {
  const aliases = (config as { resolve?: { alias?: unknown } }).resolve?.alias;
  if (!Array.isArray(aliases)) {
    throw new Error("expected ui package vitest aliases");
  }
  const alias = aliases.find((candidate): candidate is { find: string; replacement: string } =>
    Boolean(
      candidate &&
      typeof candidate === "object" &&
      "find" in candidate &&
      candidate.find === specifier &&
      "replacement" in candidate &&
      typeof candidate.replacement === "string",
    ),
  );
  if (!alias) {
    throw new Error(`missing ui package vitest alias ${specifier}`);
  }
  return alias;
}

describe("ui package vitest config", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("routes the standalone UI config through the canonical group executor", () => {
    expect(buildVitestRunPlans(["ui/vitest.config.ts"])).toEqual([
      {
        config: "ui/vitest.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("keeps native Chromium files out of root jsdom without dropping Node-driven Playwright files", async () => {
    const includeFile = path.join(tempDirs.make("ui-node-selection-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(["ui/src/**/*.test.ts"]));
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", includeFile);
    vi.resetModules();
    const config = (await import("../ui/vitest.config.ts")).default;
    const uiRoot = path.join(process.cwd(), "ui");
    const projects = (requireTestConfig(config).projects ?? []).map(requireTestConfig);
    const browser = projects.find((project) => project.browser?.enabled);
    const node = projects.find((project) => project.name === "unit-node");
    const root = requireTestConfig(createUiVitestConfig());
    const nativeFiles = globSync(browser?.include ?? [], {
      cwd: uiRoot,
      exclude: browser?.exclude,
    }).map((file) => `ui/${file}`);
    const nodeFiles = globSync(node?.include ?? [], {
      cwd: uiRoot,
      exclude: node?.exclude,
    })
      .filter((file) => file.endsWith(".browser.test.ts"))
      .map((file) => `ui/${file}`);
    const rootFiles = globSync(root.include ?? [], { exclude: root.exclude });
    expect(nativeFiles).toContain("ui/src/components/markdown-mermaid.runtime.browser.test.ts");
    expect(nodeFiles).toContain("ui/src/components/form-controls.browser.test.ts");
    expect(rootFiles.filter((file) => nativeFiles.includes(file))).toEqual([]);
    expect(rootFiles).toEqual(expect.arrayContaining(nodeFiles));
    expect([...nativeFiles, ...nodeFiles].toSorted()).toEqual(
      globSync("ui/src/**/*.browser.test.ts").toSorted(),
    );
    writeFileSync(includeFile, JSON.stringify([...nativeFiles, ...nodeFiles]));
    const scopedRoot = requireTestConfig(
      createUiVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
    );
    expect(globSync(scopedRoot.include ?? [], { exclude: scopedRoot.exclude }).toSorted()).toEqual(
      nodeFiles.toSorted(),
    );
  });

  it.each([
    [
      ["ui/src/pages/chat/chat-view.test.ts", "ui/src/pages/chat/chat-pane-lifecycle.test.ts"],
      ["ui/src/pages/chat/chat-pane-lifecycle.test.ts", "ui/src/pages/chat/chat-view.test.ts"],
    ],
    [["src/pages/chat/chat-view.test.ts"], []],
    [
      [
        "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
        "ui/src/components/form-controls.browser.test.ts",
      ],
      [
        "ui/src/components/form-controls.browser.test.ts",
        "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
      ],
    ],
    [[], []],
  ])("intersects a repository include list with every project: %j", async (requested, expected) => {
    const includeFile = path.join(tempDirs.make("ui-package-selection-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(requested));
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", includeFile);
    vi.resetModules();
    const config = (await import("../ui/vitest.config.ts")).default;
    const uiRoot = path.join(process.cwd(), "ui");
    expect(config.root).toBe(uiRoot);
    const selected = (requireTestConfig(config).projects ?? []).flatMap((project) => {
      const test = requireTestConfig(project);
      return globSync(test.include ?? [], { cwd: uiRoot, exclude: test.exclude }).map(
        (file) => `ui/${file.replaceAll("\\", "/")}`,
      );
    });
    expect(new Set(selected).size).toBe(selected.length);
    expect(selected.toSorted()).toEqual(expected);
  });

  it("keeps the standalone ui package on thread workers without broad isolation", () => {
    const testConfig = requireTestConfig(uiConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.projects).toHaveLength(4);
    expect(testConfig.maxWorkers).toBeGreaterThan(0);
    expect(testConfig.clearMocks).toBe(false);

    for (const project of testConfig.projects ?? []) {
      const projectTestConfig = requireTestConfig(project);
      expect((project as { extends?: boolean }).extends).toBe(false);
      expect(projectTestConfig.clearMocks).toBe(false);
      expect(projectTestConfig.pool).toBe("threads");
      // Project overrides would defeat CI's explicit --maxWorkers limit.
      expect(projectTestConfig.maxWorkers).toBeUndefined();
      expect(projectTestConfig.isolate).toBe(projectTestConfig.name === "unit-mock-registry");
    }
  });

  // The invariant, not a snapshot: `unit` shares one module graph and jsdom
  // window across files, so without the cleanup runner the first file to
  // evaluate a component owns it for the whole worker and a later file's
  // vi.mock never reaches production. Two projects are exempt for stated
  // reasons: `browser` runs in browser mode, where the runner's node:fs and
  // server-module imports cannot load, and `unit-node` carries the
  // Playwright-driven layout tests whose browser lives in module scope, which
  // per-file module resets churn.
  it("runs the shared jsdom ui project on the cross-file cleanup runner", () => {
    const projects = requireTestConfig(uiConfig).projects ?? [];
    const wiring = projects.map((project) => {
      const projectTestConfig = requireTestConfig(project);
      return {
        name: projectTestConfig.name,
        runner: projectTestConfig.runner
          ? normalizeConfigPath(projectTestConfig.runner)
          : undefined,
      };
    });

    expect(wiring).toEqual([
      { name: "unit", runner: "test/non-isolated-runner.ts" },
      { name: "unit-mock-registry", runner: undefined },
      { name: "unit-node", runner: undefined },
      { name: "browser", runner: undefined },
    ]);
  });

  it("uses the repository transform-cache policy at the root and in every UI project", () => {
    const root = requireTestConfig(uiConfig);
    const expected = loadVitestExperimentalConfig(
      process.env,
      process.platform,
      path.join(process.cwd(), "ui"),
    ).experimental;
    const configs = [root, ...(root.projects ?? []).map(requireTestConfig)];

    expect(configs.map((config) => config.experimental)).toEqual(configs.map(() => expected));
  });

  it("keeps the standalone ui node config on thread workers without isolation", () => {
    const testConfig = requireTestConfig(uiNodeConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.runner).toBeUndefined();
    expect(testConfig.clearMocks).toBe(false);
  });

  it("aliases the scope-upgrade workspace subpath for clean browser test checkouts", () => {
    expect(requireAlias(uiConfig, "@openclaw/gateway-client/scope-upgrade")).toEqual({
      find: "@openclaw/gateway-client/scope-upgrade",
      replacement: path.join(
        process.cwd(),
        "packages",
        "gateway-client",
        "src",
        "scope-upgrade.ts",
      ),
    });
  });
});
