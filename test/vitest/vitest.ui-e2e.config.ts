// Vitest ui e2e config wires the ui e2e test shard.
import { defineConfig, type TestUserConfig } from "vitest/config";
import {
  intersectIncludePatterns,
  loadPatternListFromEnv,
  narrowIncludePatternsForCli,
} from "./vitest.pattern-file.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";
import { UiE2eSequencer } from "./vitest.ui-e2e.sequencer.ts";

const mediaTranscriptRealGatewayTest =
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts";
const uiE2eIncludePatterns = ["ui/src/**/*.e2e.test.ts", mediaTranscriptRealGatewayTest];
export const uiE2eRealGatewayTestFiles = [
  "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
  "ui/src/e2e/control-ui-auth-transports.e2e.test.ts",
  "ui/src/e2e/logs-lifecycle.e2e.test.ts",
  "ui/src/e2e/mcp-app-conformance.e2e.test.ts",
  "ui/src/e2e/session-progress-hovercard.real-gateway.e2e.test.ts",
  "ui/src/e2e/usage-sessions-owner-attribution.e2e.test.ts",
  mediaTranscriptRealGatewayTest,
];

// These files start a private source-module Vite server instead of leasing the
// global production bundle. Keep their shared optimizer cache under one worker.
export const uiE2ePrivateServerTestFiles = [
  "ui/src/e2e/approval-bootstrap.e2e.test.ts",
  "ui/src/e2e/build-info-unicode.e2e.test.ts",
  "ui/src/e2e/chat-code-block-fences.e2e.test.ts",
  "ui/src/e2e/chat-markdown-table-interactions.e2e.test.ts",
  "ui/src/e2e/child-session-load-errors.e2e.test.ts",
  "ui/src/e2e/composer-draft-store.e2e.test.ts",
  "ui/src/e2e/composer-recovery-fences.e2e.test.ts",
  "ui/src/e2e/control-ui-shell-routing.e2e.test.ts",
  "ui/src/e2e/cron-loading.e2e.test.ts",
  "ui/src/e2e/gateway-foreground-recovery.e2e.test.ts",
  "ui/src/e2e/initial-connect-splash.e2e.test.ts",
  "ui/src/e2e/locale-offline-retry.e2e.test.ts",
  "ui/src/e2e/mcp-app-conformance.e2e.test.ts",
  "ui/src/e2e/mobile-chat-session-menu.e2e.test.ts",
  "ui/src/e2e/mobile-sidebar-session-menu.e2e.test.ts",
  "ui/src/e2e/mount-recovery.e2e.test.ts",
  "ui/src/e2e/session-management.delete.e2e.test.ts",
  "ui/src/e2e/settings-loading-skeletons.e2e.test.ts",
  "ui/src/e2e/sidebar-account-footer.e2e.test.ts",
  "ui/src/e2e/terminal-runtime.e2e.test.ts",
];

export const uiE2eRuntimeBudgetTestFile = "ui/src/e2e/chat-stream-runtime-budgets.e2e.test.ts";

// Real Gateways never overlap the parallel phase when the CI skip is absent.
export const uiE2eSerialTestFiles = [
  ...new Set([
    ...uiE2ePrivateServerTestFiles,
    ...uiE2eRealGatewayTestFiles,
    uiE2eRuntimeBudgetTestFile,
  ]),
].toSorted();

// These independent fixture/build owners do not share the source optimizer cache.
// New files stay bundled unless they own every UI server they use.
const uiE2eStandaloneTestFiles = [
  "ui/src/e2e/board-fixture.e2e.test.ts",
  "ui/src/e2e/control-ui-retained-assets.e2e.test.ts",
  "ui/src/e2e/service-worker-update.e2e.test.ts",
];

export function createUiE2eVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  const base = sharedVitestConfig as Record<string, unknown>;
  const baseTest = sharedVitestConfig.test ?? {};
  const baseSequence = (baseTest as { sequence?: object }).sequence;
  const realGatewayExclude =
    env.OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY === "1" ? uiE2eRealGatewayTestFiles : [];
  const exclude = [
    ...(baseTest.exclude ?? []).filter((pattern) => pattern !== "**/*.e2e.test.ts"),
    ...realGatewayExclude,
  ];
  const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
  const include =
    includeFromEnv ??
    narrowIncludePatternsForCli(uiE2eIncludePatterns, argv) ??
    uiE2eIncludePatterns;
  const serialInclude = (intersectIncludePatterns(uiE2eSerialTestFiles, include) ?? []).toSorted();
  const chromiumSetup = "test/vitest/vitest.ui-e2e.global-setup.ts";
  // Vitest resolves dependency directories per project even though ProjectConfig
  // narrows that type. Keep the shared cached dependency roots intact.
  const projectTest: TestUserConfig = {
    ...baseTest,
    environment: "node",
    // Polls await Chromium renders; all projects retain the loaded-CI budget.
    expect: { poll: { interval: 100, timeout: 15_000 } },
    globalSetup: [chromiumSetup],
    isolate: true,
    // Inherit root concurrency so Vitest's --maxWorkers override still applies.
    maxWorkers: undefined,
    pool: "forks",
    runner: undefined,
    setupFiles: [],
  };
  const bundledSetup = {
    globalSetup: [chromiumSetup, "test/vitest/vitest.ui-e2e.bundled.global-setup.ts"],
    setupFiles: ["test/vitest/vitest.ui-e2e.setup.ts"],
  };
  const serialScheduling = {
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { ...baseSequence, groupOrder: 1 },
  };

  return defineConfig({
    ...base,
    cacheDir: ".artifacts/vite-ui-e2e",
    test: {
      ...baseTest,
      exclude,
      // Only a selected bundle consumer acquires the invocation's shared preview.
      globalSetup: [],
      // Keep the root inventory visible to config discovery. Vitest runs only
      // the inline projects when `projects` is present.
      include,
      maxWorkers: Math.min(2, baseTest.maxWorkers),
      // ui-e2e-projects-contract-v1: frozen-target preflight may select these projects.
      projects: [
        {
          ...base,
          cacheDir: ".artifacts/vite-ui-e2e-bundled",
          test: {
            ...projectTest,
            ...bundledSetup,
            exclude: [...exclude, ...uiE2eSerialTestFiles, ...uiE2eStandaloneTestFiles],
            include,
            name: "ui-e2e-bundled",
            sequence: { ...baseSequence, groupOrder: 0 },
          },
        },
        {
          ...base,
          cacheDir: ".artifacts/vite-ui-e2e-standalone",
          test: {
            ...projectTest,
            exclude,
            include: intersectIncludePatterns(uiE2eStandaloneTestFiles, include) ?? [],
            name: "ui-e2e-standalone",
            sequence: { ...baseSequence, groupOrder: 0 },
          },
        },
        {
          ...base,
          cacheDir: ".artifacts/vite-ui-e2e-serial",
          test: {
            ...projectTest,
            ...bundledSetup,
            ...serialScheduling,
            exclude,
            include: serialInclude.filter((file) => !uiE2ePrivateServerTestFiles.includes(file)),
            name: "ui-e2e-serial",
          },
        },
        {
          ...base,
          cacheDir: ".artifacts/vite-ui-e2e-serial-standalone",
          test: {
            ...projectTest,
            ...serialScheduling,
            exclude,
            include: serialInclude.filter((file) => uiE2ePrivateServerTestFiles.includes(file)),
            name: "ui-e2e-serial-standalone",
          },
        },
      ],
      // Refit needs native file totals; verbose still reports cases to the output watchdog.
      reporters: [...baseTest.reporters, "default"],
      sequence: { ...baseSequence, sequencer: UiE2eSequencer },
    },
  });
}

export default createUiE2eVitestConfig();
