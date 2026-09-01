// Vitest ui e2e config wires the ui e2e test shard.
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";
import { UiE2eSequencer } from "./vitest.ui-e2e.sequencer.ts";

const mediaTranscriptRealGatewayTest =
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts";
const uiE2eIncludePatterns = ["ui/src/**/*.e2e.test.ts", mediaTranscriptRealGatewayTest];
const uiE2eRealGatewayTestFiles = [
  "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
  "ui/src/e2e/control-ui-auth-transports.e2e.test.ts",
  "ui/src/e2e/logs-lifecycle.e2e.test.ts",
  "ui/src/e2e/mcp-app-conformance.e2e.test.ts",
  "ui/src/e2e/session-progress-hovercard.real-gateway.e2e.test.ts",
  "ui/src/e2e/usage-sessions-owner-attribution.e2e.test.ts",
  mediaTranscriptRealGatewayTest,
];

function createUiE2eVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  const base = sharedVitestConfig as Record<string, unknown>;
  const baseTest = sharedVitestConfig.test ?? {};
  const baseSequence = (baseTest as { sequence?: object }).sequence;
  const exclude = [
    ...(baseTest.exclude ?? []).filter((pattern) => pattern !== "**/*.e2e.test.ts"),
    ...(env.OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY === "1" ? uiE2eRealGatewayTestFiles : []),
  ];
  const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
  const include =
    includeFromEnv ??
    narrowIncludePatternsForCli(uiE2eIncludePatterns, argv) ??
    uiE2eIncludePatterns;

  return defineConfig({
    ...base,
    cacheDir: ".artifacts/vite-ui-e2e",
    test: {
      ...baseTest,
      environment: "node",
      exclude,
      // Vitest's expect.poll defaults to a 1s deadline; these polls await real
      // Chromium renders, which loaded CI runners regularly stall past 1s.
      // Correctness is the eventual state, so a larger budget only trades
      // failure latency, not coverage.
      expect: { poll: { interval: 100, timeout: 15_000 } },
      fileParallelism: false,
      globalSetup: ["test/vitest/vitest.ui-e2e.global-setup.ts"],
      include,
      isolate: true,
      name: "ui-e2e",
      pool: "forks",
      // Refit needs native file totals; verbose still reports cases to the output watchdog.
      reporters: [...baseTest.reporters, "default"],
      runner: undefined,
      sequence: { ...baseSequence, sequencer: UiE2eSequencer },
      setupFiles: ["test/vitest/vitest.ui-e2e.setup.ts"],
    },
  });
}

export default createUiE2eVitestConfig();
