// Control UI config module wires vitest behavior.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { chromium } from "playwright";
import { defineConfig, defineProject } from "vitest/config";
import {
  jsdomOptimizedDeps,
  nonIsolatedRunnerPath,
  resolveDefaultVitestPool,
  sharedVitestConfig,
} from "../test/vitest/vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "../test/vitest/vitest.ui-isolated-paths.mjs";
import { controlUiLocaleModulesPlugin } from "./config/control-ui-locales.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const workspaceSourceAliases = [
  {
    find: "@openclaw/gateway-client/browser",
    replacement: path.resolve(repoRoot, "packages/gateway-client/src/browser.ts"),
  },
  {
    find: "@openclaw/gateway-client/scope-upgrade",
    replacement: path.resolve(repoRoot, "packages/gateway-client/src/scope-upgrade.ts"),
  },
  {
    find: /^@openclaw\/gateway-protocol\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/gateway-protocol/src/$1.ts"),
  },
  {
    find: /^@openclaw\/(gateway-protocol|retry)$/u,
    replacement: path.resolve(repoRoot, "packages/$1/src/index.ts"),
  },
  {
    find: "../logging/redact.js",
    replacement: path.resolve(here, "src/lib/browser-redact.ts"),
  },
  {
    find: "openclaw/plugin-sdk/test-fixtures",
    replacement: path.resolve(repoRoot, "src/plugin-sdk/test-fixtures.ts"),
  },
  {
    find: /^@openclaw\/model-catalog-core\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/model-catalog-core/src/$1.ts"),
  },
  {
    find: "@openclaw/model-catalog-core",
    replacement: path.resolve(repoRoot, "packages/model-catalog-core/src/index.ts"),
  },
  {
    find: /^@openclaw\/normalization-core\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/normalization-core/src/$1"),
  },
  {
    find: "@openclaw/normalization-core",
    replacement: path.resolve(repoRoot, "packages/normalization-core/src/index.ts"),
  },
  {
    find: /^@openclaw\/media-core\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/media-core/src/$1"),
  },
  {
    find: "@openclaw/media-core",
    replacement: path.resolve(repoRoot, "packages/media-core/src/index.ts"),
  },
  {
    find: "@openclaw/session-url-contract/parse",
    replacement: path.resolve(repoRoot, "packages/session-url-contract/src/parse.ts"),
  },
  {
    find: "@openclaw/session-url-contract/share-build",
    replacement: path.resolve(repoRoot, "packages/session-url-contract/src/share-build.ts"),
  },
  {
    find: "@openclaw/session-url-contract",
    replacement: path.resolve(repoRoot, "packages/session-url-contract/src/index.ts"),
  },
  {
    find: "@openclaw/workboard-contract",
    replacement: path.resolve(repoRoot, "packages/workboard-contract/src/index.ts"),
  },
  {
    find: /^@openclaw\/net-policy\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/net-policy/src/$1"),
  },
  {
    find: "@openclaw/net-policy",
    replacement: path.resolve(repoRoot, "packages/net-policy/src/index.ts"),
  },
];
const sharedUiTestConfig = {
  isolate: false,
  pool: resolveDefaultVitestPool(),
  // Real-Chromium layout tests exceed Vitest's 5s default on 4vcpu CI runners;
  // without this the checks-ui lane flakes on cold hover/interaction tests.
  testTimeout: 60_000,
  hookTimeout: 60_000,
} as const;
const nodeDrivenBrowserLayoutTests = [
  "src/ui/chat/sidebar-session-picker.browser.test.ts",
  "src/pages/chat/chat-responsive.browser.test.ts",
  "src/pages/chat/chat-composer-undo-redo.browser.test.ts",
  "src/pages/chat/components/chat-swarm-progress.browser.test.ts",
  "src/components/form-controls.browser.test.ts",
  "src/components/sidebar-footer-layout.browser.test.ts",
  "src/pages/sessions/view.browser.test.ts",
  "src/styles/corner-shape.browser.test.ts",
  "src/styles/cursor-policy.browser.test.ts",
  "src/styles/chat-file-link-presentation.browser.test.ts",
  "src/styles/chat-github-link-presentation.browser.test.ts",
  "src/styles/shimmer.browser.test.ts",
  "src/styles/sr-only.browser.test.ts",
] as const;
const mockRegistryUnitTests = [
  ...uiIsolatedTestFiles.map((testFile) => testFile.slice("ui/".length)),
  "src/components/mcp-app-view.test.ts",
  "src/pages/chat/chat-page.test.ts",
] as const;
const chromiumExecutableOverrideEnvKey = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
const systemChromiumExecutableCandidates = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

function canRunChromiumExecutable(executablePath: string): boolean {
  const result = spawnSync(executablePath, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function resolveChromiumLaunchOptions(): { executablePath: string } | undefined {
  const override = process.env[chromiumExecutableOverrideEnvKey]?.trim();
  if (override && existsSync(override) && canRunChromiumExecutable(override)) {
    return { executablePath: override };
  }

  const defaultExecutablePath = chromium.executablePath();
  if (existsSync(defaultExecutablePath) && canRunChromiumExecutable(defaultExecutablePath)) {
    return undefined;
  }

  const systemExecutablePath = systemChromiumExecutableCandidates.find(
    (candidate) => existsSync(candidate) && canRunChromiumExecutable(candidate),
  );
  return systemExecutablePath ? { executablePath: systemExecutablePath } : undefined;
}

const chromiumLaunchOptions = resolveChromiumLaunchOptions();

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    ...sharedUiTestConfig,
    reporters: sharedVitestConfig.test.reporters,
    projects: [
      defineProject({
        plugins: [controlUiLocaleModulesPlugin()],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit",
          // isolate:false shares one worker module graph and jsdom window across
          // files, so the first file to evaluate a component owns it for the rest
          // of the worker and a later file's vi.mock never reaches production.
          // The cleanup runner retires that state per file; without it the lane
          // fails whichever sibling the size sequencer happens to pack together.
          runner: nonIsolatedRunnerPath,
          include: ["src/**/*.test.ts"],
          exclude: [
            "src/**/*.browser.test.ts",
            "src/**/*.e2e.test.ts",
            "src/**/*.node.test.ts",
            ...mockRegistryUnitTests,
          ],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        plugins: [controlUiLocaleModulesPlugin()],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          // Reuse the canonical singleton-sensitive list so the package and
          // root runners isolate the same tests without slowing the main suite.
          isolate: true,
          deps: jsdomOptimizedDeps,
          name: "unit-mock-registry",
          include: [...mockRegistryUnitTests],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        plugins: [controlUiLocaleModulesPlugin()],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit-node",
          // No cleanup runner: this project also carries the Playwright-driven
          // layout tests, whose browser lives in module scope. Resetting the
          // module graph between files churns that browser and flakes them.
          include: ["src/**/*.node.test.ts", ...nodeDrivenBrowserLayoutTests],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        plugins: [controlUiLocaleModulesPlugin()],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          name: "browser",
          // No cleanup runner: it imports node:fs and repo server modules, which
          // cannot load in browser mode. Browser files own their own teardown.
          include: ["src/**/*.browser.test.ts"],
          exclude: [...nodeDrivenBrowserLayoutTests],
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(
              chromiumLaunchOptions ? { launchOptions: chromiumLaunchOptions } : {},
            ),
            instances: [{ browser: "chromium", name: "chromium" }],
            headless: true,
            ui: false,
          },
        },
      }),
    ],
  },
});
