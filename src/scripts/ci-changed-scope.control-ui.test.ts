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
  "package.json",
  ".github/workflows/ci.yml",
  "test/vitest/vitest.ui-paths.mjs",
  "test/vitest/vitest.ui-browser.config.ts",
])("runs Chromium UI tests when %s can change the browser copilot CI route", (changedPath) => {
  expect(detectChangedScope([changedPath]).runUiTests).toBe(true);
});
