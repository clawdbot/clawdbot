import { expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

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
])("runs browser proof and Android asset builds for %s", (changedPath) => {
  expect(detectChangedScope([changedPath])).toMatchObject({
    runNode: true,
    runUiTests: true,
    runAndroid: true,
    runMacos: false,
    runIosBuild: false,
    runControlUiI18n: false,
  });
});

it.each([
  "packages/normalization-core/src/string-normalization.ts",
  "packages/normalization-core/src/record-coerce.test.ts",
])("keeps unrelated normalization changes out of Mermaid asset builds: %s", (changedPath) => {
  expect(detectChangedScope([changedPath])).toMatchObject({
    runNode: true,
    runAndroid: false,
    runUiTests: false,
  });
});

it.each([
  "package.json",
  ".github/workflows/ci.yml",
  "test/vitest/vitest.ui-paths.mjs",
  "test/vitest/vitest.ui-browser.config.ts",
])("runs Chromium UI tests when %s can change the browser copilot CI route", (changedPath) => {
  expect(detectChangedScope([changedPath]).runUiTests).toBe(true);
});
