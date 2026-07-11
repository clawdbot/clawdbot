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
  resolveDefaultVitestPool,
} from "../test/vitest/vitest.shared.config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const workspaceSourceAliases = [
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
  "src/components/form-controls.browser.test.ts",
  "src/pages/sessions/view.browser.test.ts",
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
    projects: [
      defineProject({
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts", "src/**/*.e2e.test.ts", "src/**/*.node.test.ts"],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit-node",
          include: ["src/**/*.node.test.ts", ...nodeDrivenBrowserLayoutTests],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          name: "browser",
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
