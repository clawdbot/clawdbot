import { expect, it } from "vitest";

const { detectChangedScope, shouldRunIosScreenshots } =
  await import("../../scripts/ci-changed-scope.mjs");

it("runs control-ui localization checks for production UI source", () => {
  expect(detectChangedScope(["ui/src/pages/chat/chat-realtime.ts"])).toMatchObject({
    runControlUiI18n: true,
    runUiTests: true,
  });
});

it("skips control-ui localization checks for test-only UI source", () => {
  expect(detectChangedScope(["ui/src/pages/chat/chat-realtime.test.ts"]).runControlUiI18n).toBe(
    false,
  );
});

it("runs control-ui localization checks for the canonical locale config", () => {
  expect(detectChangedScope(["scripts/lib/control-ui-i18n-config.json"]).runControlUiI18n).toBe(
    true,
  );
});

it("runs Chromium UI tests for browser copilot extension changes", () => {
  expect(detectChangedScope(["extensions/browser/chrome-extension/sidepanel.ts"]).runUiTests).toBe(
    true,
  );
});

it.each([
  "packages/mermaid-renderer/package.json",
  "packages/mermaid-renderer/vite.config.ts",
  "packages/mermaid-renderer/native/index.html",
  "packages/mermaid-renderer/src/renderer.ts",
  "packages/mermaid-renderer/src/frame.js",
  "packages/mermaid-renderer/src/native.ts",
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/package.json",
  "tsconfig.json",
])("runs browser proof and all native asset builds for %s", (changedPath) => {
  expect(detectChangedScope([changedPath])).toMatchObject({
    runNode: true,
    runUiTests: true,
    runAndroid: true,
    runMacos: true,
    runIosBuild: true,
    runControlUiI18n: false,
  });
  expect(shouldRunIosScreenshots([changedPath])).toBe(true);
});

it.each([
  "packages/normalization-core/src/string-normalization.ts",
  "packages/normalization-core/src/record-coerce.test.ts",
])("keeps unrelated normalization changes out of Mermaid asset builds: %s", (changedPath) => {
  expect(detectChangedScope([changedPath])).toMatchObject({
    runNode: true,
    runAndroid: false,
    runMacos: false,
    runIosBuild: false,
    runUiTests: false,
  });
  expect(shouldRunIosScreenshots([changedPath])).toBe(false);
});

it.each([
  "package.json",
  ".github/workflows/ci.yml",
  "test/vitest/vitest.ui-paths.mjs",
  "test/vitest/vitest.ui-isolated-paths.mjs",
  "test/vitest/vitest.ui-browser.config.ts",
  "test/vitest/vitest.ui-e2e.config.ts",
  "test/vitest/vitest.ui-e2e.global-setup.ts",
  "test/vitest/vitest.ui-e2e.bundled.global-setup.ts",
  "test/vitest/vitest.ui-e2e.setup.ts",
  "test/vitest/vitest.ui-e2e.sequencer.ts",
  "test/vitest/vitest.pattern-file.ts",
  "test/vitest/vitest.performance-config.ts",
  "test/vitest/vitest.timeouts.ts",
  "test/vitest/vitest.weighted-sharding.ts",
  "scripts/lib/vitest-local-scheduling.mts",
  "test/helpers/temp-dir.ts",
  "scripts/control-ui-mock-dev.ts",
  "scripts/control-ui-mock-isolation.ts",
  "scripts/control-ui-mock-preview.ts",
  "scripts/control-ui-mock-attachments.ts",
  "scripts/check-control-ui-performance.mts",
  "scripts/check-control-ui-performance-base.mts",
  "scripts/check-control-ui-precompressed-assets.mts",
  "scripts/ui.mts",
  "scripts/ui.js",
  "config/control-ui-startup-budget-baseline.json",
  "scripts/lib/ci-test-timings.mts",
  "scripts/lib/ci-test-timings-schema.mts",
  "config/ci-test-timings.json",
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
])("runs Chromium UI tests when %s changes browser test inputs", (changedPath) => {
  expect(detectChangedScope([changedPath]).runUiTests).toBe(true);
});

it.each([
  "test/vitest/vitest.e2e.config.ts",
  "test/vitest/vitest.e2e.sequencer.ts",
  "test/vitest/vitest.tooling.config.ts",
  "test/vitest/vitest.ui.config.ts",
  "test/vitest/vitest.ui-isolated.config.ts",
  "scripts/lib/ci-node-test-plan.mts",
  "scripts/control-ui-i18n.ts",
  "extensions/qa-lab/src/suite-runtime-parity-runner.control-ui.test.ts",
])("keeps unrelated changes out of Chromium UI tests: %s", (changedPath) => {
  expect(detectChangedScope([changedPath]).runUiTests).toBe(false);
});
