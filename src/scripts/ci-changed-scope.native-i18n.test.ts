import { describe, expect, it } from "vitest";

const { assertNativeGeneratedArtifactsIsolated, shouldRunNativeI18n, shouldStrictNativeI18n } =
  await import("../../scripts/ci-changed-scope.mjs");

describe("native i18n changed scope", () => {
  it("routes Android flavor sources through native i18n", () => {
    expect(
      shouldRunNativeI18n([
        "apps/android/app/src/play/java/ai/openclaw/app/PlayBilling.kt",
        "apps/android/app/src/thirdParty/res/values/accessibility_strings.xml",
      ]),
    ).toBe(true);
  });

  it("keeps generated artifacts in isolated automation PRs", () => {
    const generatedCompanionPaths = [
      "apps/android/app/src/main/res/values/strings.xml",
      "apps/android/app/src/main/res/values/assistant.xml",
    ];
    const generatedPaths = [
      "apps/.i18n/native/sv.json",
      "apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt",
      "apps/android/app/src/main/res/values-sv/strings.xml",
      "apps/android/app/src/thirdParty/res/values-sv/accessibility_strings.xml",
      "apps/android/wear/src/main/res/values-sv/strings.xml",
      "apps/ios/Resources/Localizable.xcstrings",
      "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings",
      "apps/ios/WatchApp/sv.lproj/InfoPlist.strings",
    ];

    expect(() => assertNativeGeneratedArtifactsIsolated(generatedPaths)).not.toThrow();
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([...generatedPaths, ...generatedCompanionPaths]),
    ).not.toThrow();
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([...generatedPaths, "apps/.i18n/native-source.json"]),
    ).toThrow("Native generated locale artifacts must be isolated from source changes");
    expect(() =>
      assertNativeGeneratedArtifactsIsolated(
        [...generatedPaths, "apps/ios/Sources/RootTabs.swift"],
        "main",
      ),
    ).not.toThrow();
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([
        ...generatedCompanionPaths,
        "apps/.i18n/native-source.json",
      ]),
    ).not.toThrow();
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([
        ...generatedPaths,
        ...generatedCompanionPaths,
        "apps/.i18n/native-source.json",
      ]),
    ).toThrow("Native generated locale artifacts must be isolated from source changes");
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([
        ...generatedPaths,
        ...generatedCompanionPaths,
        "apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt",
      ]),
    ).toThrow("Native generated locale artifacts must be isolated from source changes");
  });

  it("allows only the owner-complete one-time native v2 artifact migration", () => {
    const owners = [
      ".gitattributes",
      "scripts/ci-changed-scope.mjs",
      "scripts/native-app-i18n.ts",
      "scripts/android-app-i18n.ts",
      "scripts/apple-app-i18n.ts",
      "test/scripts/native-app-i18n.test.ts",
      "test/scripts/apple-app-i18n.test.ts",
      "src/scripts/ci-changed-scope.native-i18n.test.ts",
    ];
    const generated = [
      "apps/.i18n/native/sv.json",
      "apps/android/app/src/main/res/values-sv/strings.xml",
      "apps/android/wear/src/main/res/values-sv/strings.xml",
      "apps/ios/Resources/Localizable.xcstrings",
      "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings",
    ];
    const migration = [...owners, "apps/.i18n/native-source.json", ...generated];

    expect(() => assertNativeGeneratedArtifactsIsolated(migration)).not.toThrow();
    expect(() => assertNativeGeneratedArtifactsIsolated(migration.slice(1))).toThrow(
      "Native generated locale artifacts must be isolated from source changes",
    );
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([
        ...migration,
        "apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt",
      ]),
    ).toThrow("Native generated locale artifacts must be isolated from source changes");
  });

  it("runs strict parity only for manual or generated-artifact checks", () => {
    expect(shouldStrictNativeI18n(null)).toBe(true);
    expect(shouldStrictNativeI18n(["apps/.i18n/native/sv.json"])).toBe(true);
    expect(
      shouldStrictNativeI18n([
        "apps/android/app/src/thirdParty/res/values-sv/accessibility_strings.xml",
      ]),
    ).toBe(true);
    expect(shouldStrictNativeI18n(["apps/ios/Resources/Localizable.xcstrings"])).toBe(true);
    expect(
      shouldStrictNativeI18n(["apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings"]),
    ).toBe(true);
    expect(
      shouldStrictNativeI18n(["apps/ios/Sources/RootTabs.swift", "apps/.i18n/native-source.json"]),
    ).toBe(false);
  });
});
