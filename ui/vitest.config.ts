// Control UI config module wires vitest behavior.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
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
    replacement: path.resolve(here, "src/ui/browser-redact.ts"),
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
} as const;
const nodeDrivenBrowserLayoutTests = [
  "src/ui/chat/chat-responsive.browser.test.ts",
  "src/ui/form-controls.browser.test.ts",
  "src/ui/views/sessions.browser.test.ts",
] as const;

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
            provider: playwright(),
            instances: [{ browser: "chromium", name: "chromium" }],
            headless: true,
            ui: false,
          },
        },
      }),
    ],
  },
});
