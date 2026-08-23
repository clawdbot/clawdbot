import { describe, expect, it } from "vitest";

const { detectChangedScope, shouldRunIosScreenshots } =
  await import("../../scripts/ci-changed-scope.mjs");

describe("shouldRunIosScreenshots", () => {
  it("conservatively routes screenshot-pipeline owners to release capture", () => {
    for (const changedPath of [
      "apps/ios/Sources/RootTabs.swift",
      "apps/ios/fastlane/Fastfile",
      "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatView.swift",
      "apps/swabble/Sources/SwabbleKit/WakeWordGate.swift",
      "scripts/ios-screenshots.sh",
      "scripts/lib/ios-fastlane.sh",
      "scripts/ios-write-swift-filelist.mjs",
      "config/swiftformat",
    ]) {
      expect(shouldRunIosScreenshots([changedPath]), changedPath).toBe(true);
    }

    for (const changedPath of [
      "apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt",
      "docs/ci.md",
      "ui/src/pages/activity/activity-page.ts",
    ]) {
      expect(shouldRunIosScreenshots([changedPath]), changedPath).toBe(false);
    }

    expect(shouldRunIosScreenshots([])).toBe(false);
    expect(shouldRunIosScreenshots(null)).toBe(true);
  });

  it("keeps screenshot capture wrappers inside the iOS build lane", () => {
    for (const changedPath of ["scripts/ios-screenshots.sh", "scripts/lib/ios-fastlane.sh"]) {
      expect(detectChangedScope([changedPath]).runIosBuild, changedPath).toBe(true);
    }
  });
});
