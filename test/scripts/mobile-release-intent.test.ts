import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MOBILE_RELEASE_INTENT_MAX_BYTES,
  mobileReleasePlanDigest,
  mobileReleaseRefForIntent,
  readMobileReleaseIntent,
  validateMobileReleaseIntent,
  writeMobileReleaseIntent,
} from "../../scripts/mobile-release-intent.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const TARGET_SHA = "b".repeat(40);
const RECEIPT_DIGEST = `sha256:${"a".repeat(64)}`;
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function signIntent<T extends Record<string, unknown>>(value: T): T & { planDigest: string } {
  return { ...value, planDigest: mobileReleasePlanDigest(value) };
}

function iosIntent() {
  return signIntent({
    appStoreVersion: "2026.9.20",
    authorityReceiptDigest: RECEIPT_DIGEST,
    buildNumber: "8",
    gatewayVersion: "2026.9.2",
    internalGroupId: "group-123",
    internalGroupName: "OpenClaw Internal",
    kind: "openclaw-mobile-release-ref-intent",
    platform: "ios",
    schemaVersion: 2,
    targetRef: "release/2026.9.2-mobile",
    targetSha: TARGET_SHA,
  });
}

function androidIntent() {
  return signIntent({
    authorityReceiptDigest: RECEIPT_DIGEST,
    gatewayVersion: "2026.9.2",
    kind: "openclaw-mobile-release-ref-intent",
    phoneVersionCode: "2026090201",
    platform: "android",
    schemaVersion: 2,
    targetRef: "release/2026.9.2-mobile",
    targetSha: TARGET_SHA,
    versionName: "2026.9.2",
    wearVersionCode: "2026090251",
  });
}

describe("mobile release intent", () => {
  it("round-trips separate gateway and accepted store identities into derived refs", () => {
    const root = tempRoots.make("openclaw-mobile-release-intent-");
    const iosPath = path.join(root, "ios.json");
    const androidPath = path.join(root, "android.json");

    writeMobileReleaseIntent(iosPath, iosIntent());
    writeMobileReleaseIntent(androidPath, androidIntent());

    expect(readMobileReleaseIntent(iosPath)).toEqual(iosIntent());
    expect(readMobileReleaseIntent(androidPath)).toEqual(androidIntent());
    expect(readMobileReleaseIntent(iosPath)).toMatchObject({
      appStoreVersion: "2026.9.20",
      buildNumber: "8",
      gatewayVersion: "2026.9.2",
    });
    expect(mobileReleaseRefForIntent(readMobileReleaseIntent(iosPath))).toBe(
      "refs/openclaw/mobile-releases/ios/2026.9.20-8",
    );
    expect(mobileReleaseRefForIntent(readMobileReleaseIntent(androidPath))).toBe(
      "refs/openclaw/mobile-releases/android/2026.9.2-2026090201",
    );
    expect(fs.statSync(iosPath).size).toBeLessThanOrEqual(MOBILE_RELEASE_INTENT_MAX_BYTES);
  });

  it("rejects extra keys, target injection, and noncanonical JSON", () => {
    expect(() => validateMobileReleaseIntent({ ...iosIntent(), command: "git push" })).toThrow(
      "unexpected shape",
    );
    expect(() =>
      validateMobileReleaseIntent({
        ...iosIntent(),
        targetRef: "release/2026.9.2-mobile/../../main",
      }),
    ).toThrow("target ref");

    const root = tempRoots.make("openclaw-mobile-release-intent-noncanonical-");
    const file = path.join(root, "intent.json");
    fs.writeFileSync(file, JSON.stringify(iosIntent(), null, 2));
    expect(() => readMobileReleaseIntent(file)).toThrow("canonical closed-schema form");
  });

  it("rejects receipt, plan, and platform identity mismatches", () => {
    expect(() =>
      validateMobileReleaseIntent({
        ...iosIntent(),
        authorityReceiptDigest: `sha256:${"c".repeat(64)}`,
      }),
    ).toThrow("plan digest");
    expect(() =>
      validateMobileReleaseIntent({
        ...iosIntent(),
        gatewayVersion: "2026.9.3",
      }),
    ).toThrow("App Store version");
    expect(() =>
      validateMobileReleaseIntent({
        ...androidIntent(),
        versionName: "2026.9.3",
      }),
    ).toThrow("versionName");
    expect(() =>
      validateMobileReleaseIntent({
        ...androidIntent(),
        wearVersionCode: "2026090252",
      }),
    ).toThrow("plus 50");
  });

  it("rejects malformed distribution identity and oversized intent files", () => {
    expect(() =>
      validateMobileReleaseIntent({
        ...iosIntent(),
        internalGroupName: "OpenClaw\nInternal",
      }),
    ).toThrow("bounded printable string");

    const root = tempRoots.make("openclaw-mobile-release-intent-large-");
    const file = path.join(root, "intent.json");
    fs.writeFileSync(file, "x".repeat(MOBILE_RELEASE_INTENT_MAX_BYTES + 1));
    expect(() => readMobileReleaseIntent(file)).toThrow("no larger than 4 KiB");
  });
});
