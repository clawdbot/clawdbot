#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MOBILE_RELEASE_INTENT_KIND = "openclaw-mobile-release-ref-intent";
export const MOBILE_RELEASE_INTENT_MAX_BYTES = 4 * 1024;

const VERSION_RE = /^20[0-9]{2}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/u;
const TARGET_REF_RE = /^release\/(20[0-9]{2}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*)-mobile$/u;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label = "Mobile release intent") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(keys.toSorted())
  ) {
    fail(`${label} has an unexpected shape.`);
  }
}

function hasAsciiControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function boundedString(value, name, maxLength = 200) {
  const normalized = String(value ?? "");
  if (
    normalized.length < 1 ||
    normalized.length > maxLength ||
    normalized.trim() !== normalized ||
    hasAsciiControlCharacter(normalized)
  ) {
    fail(`${name} must be a bounded printable string.`);
  }
  return normalized;
}

function positiveInteger(value, name) {
  const normalized = String(value ?? "");
  if (!POSITIVE_INTEGER_RE.test(normalized)) {
    fail(`${name} must be a positive integer.`);
  }
  return normalized;
}

function releaseVersion(value, name = "Mobile gateway version") {
  const normalized = String(value ?? "");
  if (!VERSION_RE.test(normalized)) {
    fail(`${name} must match YYYY.M.PATCH.`);
  }
  return normalized;
}

function targetRef(value, gatewayVersion) {
  const normalized = String(value ?? "");
  const match = TARGET_REF_RE.exec(normalized);
  if (!match || match[1] !== gatewayVersion) {
    fail("Mobile release target ref must exactly match release/YYYY.M.PATCH-mobile.");
  }
  return normalized;
}

function targetSha(value) {
  const normalized = String(value ?? "");
  if (!SHA_RE.test(normalized)) {
    fail("Mobile release target SHA must be a full lowercase commit SHA.");
  }
  return normalized;
}

function digest(value, name) {
  const normalized = String(value ?? "");
  if (!DIGEST_RE.test(normalized)) {
    fail(`${name} must be a canonical sha256 digest.`);
  }
  return normalized;
}

function iosStoreIdentity(value, gatewayVersion) {
  const appStoreVersion = releaseVersion(value.appStoreVersion, "iOS App Store version");
  const escapedGateway = gatewayVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^${escapedGateway}[0-9]$`, "u").test(appStoreVersion)) {
    fail("iOS App Store version must be the gateway version plus one revision digit.");
  }
  return {
    appStoreVersion,
    buildNumber: positiveInteger(value.buildNumber, "iOS build number"),
    internalGroupId: boundedString(value.internalGroupId, "TestFlight internal group ID"),
    internalGroupName: boundedString(value.internalGroupName, "TestFlight internal group name"),
  };
}

function androidVersionCodePrefix(version) {
  const [year, month, patch] = version.split(".");
  return `${year}${month.padStart(2, "0")}${patch.padStart(2, "0")}`;
}

function androidStoreIdentity(value, gatewayVersion) {
  const versionName = releaseVersion(value.versionName, "Android versionName");
  if (versionName !== gatewayVersion) {
    fail("Android versionName must exactly match the mobile gateway version.");
  }
  if (
    value.phoneTrack !== "internal" ||
    value.wearTrack !== "wear:internal" ||
    value.releaseStatus !== "completed" ||
    value.playEditState !== "committed"
  ) {
    fail(
      "Android beta intent must bind internal and wear:internal tracks, completed status, and a committed Play edit.",
    );
  }
  const phoneVersionCode = positiveInteger(value.phoneVersionCode, "Android phone versionCode");
  const wearVersionCode = positiveInteger(value.wearVersionCode, "Android Wear versionCode");
  const prefix = androidVersionCodePrefix(gatewayVersion);
  const phoneSuffix = Number.parseInt(phoneVersionCode.slice(prefix.length), 10);
  if (
    !phoneVersionCode.startsWith(prefix) ||
    phoneVersionCode.length !== prefix.length + 2 ||
    !Number.isInteger(phoneSuffix) ||
    phoneSuffix < 1 ||
    phoneSuffix > 49
  ) {
    fail(`Android phone versionCode must match ${prefix}01 through ${prefix}49.`);
  }
  if (BigInt(wearVersionCode) !== BigInt(phoneVersionCode) + 50n) {
    fail("Android Wear versionCode must be the phone versionCode plus 50.");
  }
  return {
    phoneTrack: value.phoneTrack,
    phoneVersionCode,
    playEditState: value.playEditState,
    releaseStatus: value.releaseStatus,
    versionName,
    wearTrack: value.wearTrack,
    wearVersionCode,
  };
}

function planPayload(value) {
  const gatewayVersion = releaseVersion(value.gatewayVersion);
  const platform = value.platform;
  if (platform !== "ios" && platform !== "android") {
    fail("Mobile release intent platform must be ios or android.");
  }
  return {
    authorityReceiptDigest: digest(
      value.authorityReceiptDigest,
      "Mobile release authority receipt digest",
    ),
    gatewayVersion,
    platform,
    storeIdentity:
      platform === "ios"
        ? iosStoreIdentity(value, gatewayVersion)
        : androidStoreIdentity(value, gatewayVersion),
    targetRef: targetRef(value.targetRef, gatewayVersion),
    targetSha: targetSha(value.targetSha),
  };
}

export function mobileReleasePlanDigest(value) {
  const bytes = JSON.stringify(planPayload(value));
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function validateMobileReleaseIntent(value) {
  const platform = value?.platform;
  const commonKeys = [
    "authorityReceiptDigest",
    "gatewayVersion",
    "kind",
    "planDigest",
    "platform",
    "schemaVersion",
    "targetRef",
    "targetSha",
  ];
  const platformKeys =
    platform === "ios"
      ? ["appStoreVersion", "buildNumber", "internalGroupId", "internalGroupName"]
      : platform === "android"
        ? [
            "phoneTrack",
            "phoneVersionCode",
            "playEditState",
            "releaseStatus",
            "versionName",
            "wearTrack",
            "wearVersionCode",
          ]
        : [];
  exactKeys(value, [...commonKeys, ...platformKeys]);
  const payload = planPayload(value);
  const intent = {
    authorityReceiptDigest: payload.authorityReceiptDigest,
    gatewayVersion: payload.gatewayVersion,
    kind: MOBILE_RELEASE_INTENT_KIND,
    planDigest: digest(value.planDigest, "Mobile release plan digest"),
    platform,
    schemaVersion: 2,
    targetRef: payload.targetRef,
    targetSha: payload.targetSha,
    ...payload.storeIdentity,
  };
  if (value.kind !== intent.kind || value.schemaVersion !== intent.schemaVersion) {
    fail("Mobile release intent kind or schema version is invalid.");
  }
  if (intent.planDigest !== mobileReleasePlanDigest(intent)) {
    fail("Mobile release plan digest does not match the signed release tuple.");
  }
  return intent;
}

export function mobileReleaseRefForIntent(value) {
  const intent = validateMobileReleaseIntent(value);
  if (intent.platform === "ios") {
    return `refs/openclaw/mobile-releases/ios/${intent.appStoreVersion}-${intent.buildNumber}`;
  }
  return `refs/openclaw/mobile-releases/android/${intent.versionName}-${intent.phoneVersionCode}`;
}

function canonicalMobileReleaseIntentBytes(value) {
  return `${JSON.stringify(validateMobileReleaseIntent(value))}\n`;
}

export function readMobileReleaseIntent(file) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MOBILE_RELEASE_INTENT_MAX_BYTES
  ) {
    fail("Mobile release intent must be a regular file no larger than 4 KiB.");
  }
  const source = fs.readFileSync(file, "utf8");
  const intent = validateMobileReleaseIntent(JSON.parse(source));
  if (source !== canonicalMobileReleaseIntentBytes(intent)) {
    fail("Mobile release intent is not in canonical closed-schema form.");
  }
  return intent;
}

export function writeMobileReleaseIntent(file, value) {
  const intent = validateMobileReleaseIntent(value);
  const source = canonicalMobileReleaseIntentBytes(intent);
  if (Buffer.byteLength(source) > MOBILE_RELEASE_INTENT_MAX_BYTES) {
    fail("Mobile release intent exceeds 4 KiB.");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, source, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
  return intent;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("-")) {
    fail(`Missing ${name}.`);
  }
  return argv[index + 1];
}

function main(argv) {
  if (argv[0] !== "write") {
    fail("Expected the write command.");
  }
  const platform = option(argv, "--platform");
  const common = {
    authorityReceiptDigest: option(argv, "--authority-receipt-digest"),
    gatewayVersion: option(argv, "--gateway-version"),
    kind: MOBILE_RELEASE_INTENT_KIND,
    platform,
    schemaVersion: 2,
    targetRef: option(argv, "--target-ref"),
    targetSha: option(argv, "--target-sha"),
  };
  const storeIdentity =
    platform === "ios"
      ? {
          appStoreVersion: option(argv, "--app-store-version"),
          buildNumber: option(argv, "--build-number"),
          internalGroupId: option(argv, "--internal-group-id"),
          internalGroupName: option(argv, "--internal-group-name"),
        }
      : {
          phoneTrack: option(argv, "--phone-track"),
          phoneVersionCode: option(argv, "--phone-version-code"),
          playEditState: option(argv, "--play-edit-state"),
          releaseStatus: option(argv, "--release-status"),
          versionName: option(argv, "--version-name"),
          wearTrack: option(argv, "--wear-track"),
          wearVersionCode: option(argv, "--wear-version-code"),
        };
  const unsigned = { ...common, ...storeIdentity };
  writeMobileReleaseIntent(option(argv, "--output"), {
    ...unsigned,
    planDigest: mobileReleasePlanDigest(unsigned),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
