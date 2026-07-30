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
