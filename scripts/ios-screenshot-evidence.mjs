#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CAPTURE_ATTEMPTS_FILENAME = "capture-attempts.json";
const SCREENSHOT_NAMES = [
  "01-control-connected",
  "02-chat-connected",
  "03-agent-connected",
  "04-settings-connected",
];
const FAMILY_SPECS = {
  iphone: {
    devicePattern: /^iPhone /u,
    screenshotNames: SCREENSHOT_NAMES,
    captureAttempts: true,
  },
  "ipad-13": {
    devicePattern: /^iPad (?:Air|Pro) 13-inch/u,
    screenshotNames: SCREENSHOT_NAMES,
    captureAttempts: true,
  },
  watch: {
    devicePattern: /^Apple Watch/u,
    screenshotNames: ["01-now-face"],
    captureAttempts: false,
  },
};
const EXPECTED_FAMILIES = Object.keys(FAMILY_SPECS).toSorted();
// Model only whole OpenClaw Fastlane invocations. Fastlane's internal launch
// retries remain workflow-log evidence.
const ATTEMPT_MODEL = Object.freeze({
  owner: "openclaw",
  unit: "capture_ios_screenshots invocation",
  maxAttempts: 2,
  fastlaneInternalRetries: "workflow-log",
});

function fail(message) {
  throw new Error(message);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a nonempty string`);
  }
  return value.trim();
}

function requireSha(value, label) {
  const sha = requireString(value, label);
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    fail(`${label} must be a full lowercase commit SHA`);
  }
  return sha;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    fail(`${label} must be a positive integer`);
  }
  return number;
}

function listEntries(directory) {
  if (!fs.existsSync(directory)) {
    fail(`missing evidence directory: ${directory}`);
  }
  return fs.readdirSync(directory, { withFileTypes: true });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listFilesRecursive(directory, prefix = "") {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(prefix, entry.name);
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? listFilesRecursive(absolutePath, relativePath)
        : [{ absolutePath, relativePath }];
    })
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function sha256Directory(directory) {
  const hash = crypto.createHash("sha256");
  for (const file of listFilesRecursive(directory)) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function verifyPng(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= PNG_SIGNATURE.length) {
    fail(`invalid empty PNG evidence: ${filePath}`);
  }
  const header = Buffer.alloc(PNG_SIGNATURE.length);
  const descriptor = fs.openSync(filePath, "r");
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!header.equals(PNG_SIGNATURE)) {
    fail(`invalid PNG signature: ${filePath}`);
  }
  return { bytes: stat.size, sha256: sha256File(filePath) };
}

function defaultReadXcresultSummary(resultPath) {
  const result = spawnSync(
    "xcrun",
    ["xcresulttool", "get", "test-results", "summary", "--path", resultPath, "--compact"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(
      `failed to inspect ${resultPath}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
    );
  }
  try {
    const summary = JSON.parse(result.stdout);
    return {
      testResult: requireString(summary.result, `${resultPath} test result`),
      failedTests: Number(summary.failedTests),
    };
  } catch (error) {
    return fail(`invalid xcresult summary for ${resultPath}: ${String(error)}`);
  }
}

function copyEntry(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function screenshotDeviceName(filename, screenshotName) {
  const suffix = `-${screenshotName}.png`;
  return filename.endsWith(suffix) ? filename.slice(0, -suffix.length) : undefined;
}

function collectScreenshots({ family, screenshotDirectory, familyDirectory, spec }) {
  const pngNames = listEntries(screenshotDirectory)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
    .map((entry) => entry.name);
  const matches = spec.screenshotNames.map((screenshotName) => {
    const candidates = pngNames.filter((filename) => {
      const deviceName = screenshotDeviceName(filename, screenshotName);
      return deviceName && spec.devicePattern.test(deviceName);
    });
    if (candidates.length !== 1) {
      fail(
        `${family} expected one ${screenshotName} PNG, found ${candidates.length}: ${candidates.join(", ") || "none"}`,
      );
    }
    return { filename: candidates[0], screenshotName };
  });
  const deviceNames = new Set(
    matches.map(({ filename, screenshotName }) => screenshotDeviceName(filename, screenshotName)),
  );
  if (deviceNames.size !== 1) {
    fail(`${family} screenshots span multiple devices: ${[...deviceNames].join(", ")}`);
  }
  const deviceName = [...deviceNames][0];
  const familyPngs = pngNames.filter((filename) => spec.devicePattern.test(filename));
  const expectedPngs = matches.map(({ filename }) => filename).toSorted();
  if (familyPngs.toSorted().join("\n") !== expectedPngs.join("\n")) {
    fail(
      `${family} PNG union mismatch; expected ${expectedPngs.join(", ")}, found ${familyPngs.toSorted().join(", ")}`,
    );
  }

  const screenshots = matches.map(({ filename, screenshotName }) => {
    const source = path.join(screenshotDirectory, filename);
    const artifactPath = path.posix.join("screenshots", filename);
    const metadata = verifyPng(source);
    copyEntry(source, path.join(familyDirectory, artifactPath));
    return Object.assign(
      {
        name: screenshotName,
        deviceName,
        artifactPath,
        canonicalPath: path.posix.join("apps/ios/fastlane/screenshots/en-US", filename),
      },
      metadata,
    );
  });
  return { deviceName, screenshots };
}

function readCaptureAttemptLedger(xcresultDirectory) {
  const ledgerPath = path.join(xcresultDirectory, CAPTURE_ATTEMPTS_FILENAME);
  if (!fs.existsSync(ledgerPath) || !fs.statSync(ledgerPath).isFile()) {
    fail(`missing OpenClaw capture attempt ledger: ${ledgerPath}`);
  }
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch (error) {
    return fail(`invalid OpenClaw capture attempt ledger: ${String(error)}`);
  }
  const expectedKeys = ["attempts", "schemaVersion"];
  const actualKeys =
    ledger && typeof ledger === "object" && !Array.isArray(ledger)
      ? Object.keys(ledger).toSorted((left, right) => left.localeCompare(right))
      : [];
  if (actualKeys.join("\n") !== expectedKeys.join("\n")) {
    fail("OpenClaw capture attempt ledger has an unexpected shape");
  }
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.attempts)) {
    fail("OpenClaw capture attempt ledger has an unsupported schema");
  }
  return ledger.attempts;
}

function collectCaptureAttempts({
  deviceName,
  familyDirectory,
  screenshotNames,
  xcresultDirectory,
  readXcresultSummary,
}) {
  const directoryEntries = listEntries(xcresultDirectory);
  const unexpectedEntries = directoryEntries.filter(
    (entry) =>
      !(
        (entry.isFile() && entry.name === CAPTURE_ATTEMPTS_FILENAME) ||
        (entry.isDirectory() && entry.name.endsWith(".xcresult"))
      ),
  );
  if (unexpectedEntries.length > 0) {
    fail(
      `OpenClaw capture evidence contains unexpected entries: ${unexpectedEntries.map((entry) => entry.name).join(", ")}`,
    );
  }
  const xcresultNames = directoryEntries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcresult"))
    .map((entry) => entry.name);
  const ledgerEntries = readCaptureAttemptLedger(xcresultDirectory);
  const results = [];
  for (const screenshotName of screenshotNames) {
    const attempts = ledgerEntries
      .filter((entry) => entry.deviceName === deviceName && entry.screenshotName === screenshotName)
      .toSorted((left, right) => left.attempt - right.attempt);
    const attemptNumbers = attempts.map(({ attempt }) => attempt).join(",");
    if (attemptNumbers !== "1" && attemptNumbers !== "1,2") {
      fail(
        `${deviceName} ${screenshotName} expected OpenClaw attempt 1 and optional retry 2; found ${attemptNumbers || "none"}`,
      );
    }
    const summaries = attempts.map((entry, index) => {
      const expectedKeys = ["attempt", "captureOutcome", "deviceName", "screenshotName"];
      const actualKeys =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? Object.keys(entry).toSorted((left, right) => left.localeCompare(right))
          : [];
      if (actualKeys.join("\n") !== expectedKeys.join("\n")) {
        fail(`${deviceName} ${screenshotName} has an invalid capture attempt record`);
      }
      const { attempt, captureOutcome } = entry;
      const expectedOutcome = index === attempts.length - 1 ? "succeeded" : "failed";
      if (captureOutcome !== expectedOutcome) {
        fail(`${deviceName} ${screenshotName} has an unexpected capture outcome sequence`);
      }
      const name = `${deviceName}-${screenshotName}-attempt-${attempt}.xcresult`;
      const source = path.join(xcresultDirectory, name);
      if (!fs.existsSync(source)) {
        if (captureOutcome === "succeeded") {
          fail(`${name} is missing for the successful final capture attempt`);
        }
        return {
          screenshotName,
          attempt,
          captureOutcome,
          artifactPath: null,
          canonicalPath: null,
          testResult: null,
          failedTests: null,
          sha256: null,
        };
      }
      const summary = readXcresultSummary(source);
      if (!Number.isInteger(summary.failedTests) || summary.failedTests < 0) {
        fail(`${name} has invalid failedTests`);
      }
      const artifactPath = path.posix.join("xcresults", name);
      copyEntry(source, path.join(familyDirectory, artifactPath));
      return {
        screenshotName,
        attempt,
        artifactPath,
        canonicalPath: path.posix.join("apps/ios/build/SnapshotTestResults", name),
        captureOutcome,
        testResult: summary.testResult,
        failedTests: summary.failedTests,
        sha256: sha256Directory(source),
      };
    });
    const final = summaries.at(-1);
    if (
      final.captureOutcome !== "succeeded" ||
      final.artifactPath === null ||
      final.testResult !== "Passed" ||
      final.failedTests !== 0
    ) {
      fail(`${deviceName} ${screenshotName} does not have a passing final capture attempt`);
    }
    results.push(...summaries);
  }
  if (ledgerEntries.length !== results.length) {
    fail(`${deviceName} capture attempt ledger contains unexpected evidence`);
  }
  const expectedNames = results
    .filter(({ artifactPath }) => artifactPath !== null)
    .map(({ artifactPath }) => path.posix.basename(artifactPath));
  const familyEntries = xcresultNames.filter((name) => name.startsWith(`${deviceName}-`));
  if (
    familyEntries.length !== xcresultNames.length ||
    familyEntries.toSorted((left, right) => left.localeCompare(right)).join("\n") !==
      expectedNames.toSorted((left, right) => left.localeCompare(right)).join("\n")
  ) {
    fail(`${deviceName} xcresult union contains unexpected evidence`);
  }
  return results;
}

export function collectIosScreenshotEvidence({
  family,
  screenshotDirectory,
  xcresultDirectory,
  outputDirectory,
  provenance,
  readXcresultSummary = defaultReadXcresultSummary,
}) {
  const spec = FAMILY_SPECS[family];
  if (!spec) {
    fail(`unsupported screenshot family: ${family}`);
  }
  const normalizedProvenance = {
    targetSha: requireSha(provenance.targetSha, "target SHA"),
    workflowSha: requireSha(provenance.workflowSha, "workflow SHA"),
    runId: requireString(provenance.runId, "workflow run id"),
    runAttempt: requirePositiveInteger(provenance.runAttempt, "workflow run attempt"),
    tooling: {
      xcode: requireString(provenance.tooling?.xcode, "Xcode version"),
      fastlane: requireString(provenance.tooling?.fastlane, "Fastlane version"),
      node: requireString(provenance.tooling?.node, "Node version"),
    },
  };
  const familyDirectory = path.join(outputDirectory, family);
  fs.rmSync(familyDirectory, { recursive: true, force: true });
  fs.mkdirSync(familyDirectory, { recursive: true });
  const { deviceName, screenshots } = collectScreenshots({
    family,
    screenshotDirectory,
    familyDirectory,
    spec,
  });
  const captureAttempts = spec.captureAttempts
    ? collectCaptureAttempts({
        deviceName,
        familyDirectory,
        screenshotNames: spec.screenshotNames,
        xcresultDirectory,
        readXcresultSummary,
      })
    : [];
  const manifest = {
    schemaVersion: 1,
    attemptModel: { ...ATTEMPT_MODEL },
    family,
    deviceName,
    ...normalizedProvenance,
    screenshots,
    captureAttempts,
  };
  fs.writeFileSync(
    path.join(familyDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function loadExpectedManifests(inputDirectory, targetSha) {
  const expectedContainers = {
    [`ios-release-screenshot-shard-iphone-${targetSha}`]: ["iphone"],
    [`ios-release-screenshot-shard-ipad-13-${targetSha}`]: ["ipad-13", "watch"],
  };
  const actualContainers = listEntries(inputDirectory);
  if (actualContainers.some((entry) => !entry.isDirectory())) {
    fail("screenshot evidence input contains a non-container entry");
  }
  const actualContainerNames = actualContainers.map((entry) => entry.name).toSorted();
  const expectedContainerNames = Object.keys(expectedContainers).toSorted();
  if (actualContainerNames.join("\n") !== expectedContainerNames.join("\n")) {
    fail(
      `screenshot artifact container topology mismatch; expected ${expectedContainerNames.join(", ")}, found ${actualContainerNames.join(", ") || "none"}`,
    );
  }

  return Object.entries(expectedContainers).flatMap(([containerName, expectedFamilies]) => {
    const containerDirectory = path.join(inputDirectory, containerName);
    const containerEntries = listEntries(containerDirectory);
    if (containerEntries.some((entry) => !entry.isDirectory())) {
      fail(`${containerName} contains a non-family entry`);
    }
    const actualFamilies = containerEntries.map((entry) => entry.name).toSorted();
    if (actualFamilies.join("\n") !== expectedFamilies.toSorted().join("\n")) {
      fail(
        `${containerName} family topology mismatch; expected ${expectedFamilies.join(", ")}, found ${actualFamilies.join(", ") || "none"}`,
      );
    }
    return expectedFamilies.map((family) => {
      const manifestPath = path.join(containerDirectory, family, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        fail(`${containerName} is missing ${family}/manifest.json`);
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.family !== family) {
        fail(`${containerName}/${family} contains ${manifest.family ?? "unknown"} family evidence`);
      }
      return { containerName, manifestPath, manifest };
    });
  });
}

function verifyManifestEntry(manifestPath, entry, kind) {
  const familyDirectory = path.dirname(manifestPath);
  const artifactPath = requireString(entry.artifactPath, `${kind} artifact path`);
  const canonicalPath = requireString(entry.canonicalPath, `${kind} canonical path`);
  const expectedRoot =
    kind === "screenshot"
      ? "apps/ios/fastlane/screenshots/en-US/"
      : "apps/ios/build/SnapshotTestResults/";
  const expectedArtifactRoot = kind === "screenshot" ? "screenshots/" : "xcresults/";
  const filename = path.posix.basename(canonicalPath);
  if (canonicalPath !== `${expectedRoot}${filename}`) {
    fail(`unexpected ${kind} canonical path: ${canonicalPath}`);
  }
  if (artifactPath !== `${expectedArtifactRoot}${filename}`) {
    fail(`unexpected ${kind} artifact path: ${artifactPath}`);
  }
  const source = path.join(familyDirectory, artifactPath);
  const actualDigest = kind === "screenshot" ? verifyPng(source).sha256 : sha256Directory(source);
  if (actualDigest !== entry.sha256) {
    fail(`${kind} digest mismatch for ${canonicalPath}`);
  }
  return { canonicalPath, source };
}

function verifyFamilyArtifactUnion(manifestPath, manifest) {
  const familyDirectory = path.dirname(manifestPath);
  if (path.basename(familyDirectory) !== manifest.family) {
    fail(`${manifest.family} manifest is stored under an unexpected directory`);
  }
  const xcresults = manifest.captureAttempts.filter((entry) => entry.artifactPath !== null);
  const expectedTopLevel = ["manifest.json", "screenshots"];
  if (xcresults.length > 0) {
    expectedTopLevel.push("xcresults");
  }
  const actualTopLevel = listEntries(familyDirectory)
    .map((entry) => entry.name)
    .toSorted();
  if (actualTopLevel.join("\n") !== expectedTopLevel.toSorted().join("\n")) {
    fail(`${manifest.family} shard contains unexpected evidence`);
  }

  const expectedScreenshots = manifest.screenshots
    .map((entry) => path.posix.basename(entry.artifactPath))
    .toSorted();
  const actualScreenshots = listEntries(path.join(familyDirectory, "screenshots"))
    .map((entry) => entry.name)
    .toSorted();
  if (actualScreenshots.join("\n") !== expectedScreenshots.join("\n")) {
    fail(`${manifest.family} screenshot artifact union mismatch`);
  }

  if (xcresults.length > 0) {
    const expectedXcresults = xcresults
      .map((entry) => path.posix.basename(entry.artifactPath))
      .toSorted();
    const actualXcresults = listEntries(path.join(familyDirectory, "xcresults"))
      .map((entry) => entry.name)
      .toSorted();
    if (actualXcresults.join("\n") !== expectedXcresults.join("\n")) {
      fail(`${manifest.family} xcresult artifact union mismatch`);
    }
  }
}

function verifyAttemptModel(manifest) {
  const model = manifest.attemptModel;
  const expectedKeys = Object.keys(ATTEMPT_MODEL).toSorted();
  const actualKeys =
    model && typeof model === "object" && !Array.isArray(model)
      ? Object.keys(model).toSorted()
      : [];
  if (
    actualKeys.join("\n") !== expectedKeys.join("\n") ||
    expectedKeys.some((key) => model[key] !== ATTEMPT_MODEL[key])
  ) {
    fail(`${manifest.family} has an unexpected attempt model`);
  }
}

function verifyManifestFamily(manifestPath, manifest) {
  const spec = FAMILY_SPECS[manifest.family];
  verifyAttemptModel(manifest);
  const deviceName = requireString(manifest.deviceName, `${manifest.family} device name`);
  if (!spec.devicePattern.test(deviceName)) {
    fail(`${manifest.family} has unexpected device name: ${deviceName}`);
  }
  requireString(manifest.runId, `${manifest.family} workflow run id`);
  requirePositiveInteger(manifest.runAttempt, `${manifest.family} workflow run attempt`);
  requireString(manifest.tooling?.xcode, `${manifest.family} Xcode version`);
  requireString(manifest.tooling?.fastlane, `${manifest.family} Fastlane version`);
  requireString(manifest.tooling?.node, `${manifest.family} Node version`);

  const screenshotNames = manifest.screenshots?.map((entry) => entry.name).toSorted();
  if (
    screenshotNames?.join("\n") !==
    spec.screenshotNames.toSorted((left, right) => left.localeCompare(right)).join("\n")
  ) {
    fail(`${manifest.family} screenshot name union mismatch`);
  }
  for (const screenshot of manifest.screenshots) {
    const expectedFilename = `${deviceName}-${screenshot.name}.png`;
    const expectedCanonicalPath = `apps/ios/fastlane/screenshots/en-US/${expectedFilename}`;
    if (screenshot.canonicalPath !== expectedCanonicalPath) {
      fail(`${manifest.family} has unexpected screenshot path: ${screenshot.canonicalPath}`);
    }
    if (screenshot.artifactPath !== `screenshots/${expectedFilename}`) {
      fail(
        `${manifest.family} has unexpected screenshot artifact path: ${screenshot.artifactPath}`,
      );
    }
  }

  if (!Array.isArray(manifest.captureAttempts)) {
    fail(`${manifest.family} capture attempts must be an array`);
  }
  if (!spec.captureAttempts) {
    if (manifest.captureAttempts?.length !== 0) {
      fail(`${manifest.family} must not contain capture attempt evidence`);
    }
    verifyFamilyArtifactUnion(manifestPath, manifest);
    return;
  }
  const knownScreenshotNames = new Set(spec.screenshotNames);
  if (manifest.captureAttempts.some((entry) => !knownScreenshotNames.has(entry.screenshotName))) {
    fail(`${manifest.family} capture attempt union contains an unexpected screenshot`);
  }
  for (const screenshotName of spec.screenshotNames) {
    const attempts = manifest.captureAttempts
      ?.filter((entry) => entry.screenshotName === screenshotName)
      .toSorted((left, right) => left.attempt - right.attempt);
    const attemptNumbers = attempts?.map((entry) => entry.attempt).join(",");
    if (attemptNumbers !== "1" && attemptNumbers !== "1,2") {
      fail(`${manifest.family} ${screenshotName} capture attempt union mismatch`);
    }
    const final = attempts.at(-1);
    if (
      final.captureOutcome !== "succeeded" ||
      final.artifactPath === null ||
      final.testResult !== "Passed" ||
      final.failedTests !== 0
    ) {
      fail(`${manifest.family} ${screenshotName} final xcresult is not passing`);
    }
    if (
      attempts.some(
        (entry, index) =>
          entry.captureOutcome !== (index === attempts.length - 1 ? "succeeded" : "failed"),
      )
    ) {
      fail(`${manifest.family} ${screenshotName} has an unexpected capture outcome sequence`);
    }
    for (const attempt of attempts) {
      if (attempt.artifactPath === null) {
        if (
          attempt.captureOutcome !== "failed" ||
          attempt.canonicalPath !== null ||
          attempt.testResult !== null ||
          attempt.failedTests !== null ||
          attempt.sha256 !== null
        ) {
          fail(`${manifest.family} ${screenshotName} has invalid missing xcresult evidence`);
        }
        continue;
      }
      requireString(attempt.testResult, `${manifest.family} ${screenshotName} test result`);
      if (!Number.isInteger(attempt.failedTests) || attempt.failedTests < 0) {
        fail(`${manifest.family} ${screenshotName} has invalid failedTests`);
      }
      const expectedFilename = `${deviceName}-${screenshotName}-attempt-${attempt.attempt}.xcresult`;
      const expectedCanonicalPath = `apps/ios/build/SnapshotTestResults/${expectedFilename}`;
      if (attempt.canonicalPath !== expectedCanonicalPath) {
        fail(`${manifest.family} has unexpected xcresult path: ${attempt.canonicalPath}`);
      }
      if (attempt.artifactPath !== `xcresults/${expectedFilename}`) {
        fail(`${manifest.family} has unexpected xcresult artifact path: ${attempt.artifactPath}`);
      }
    }
  }
  verifyFamilyArtifactUnion(manifestPath, manifest);
}

export function reduceIosScreenshotEvidence({ inputDirectory, outputRoot, expectedProvenance }) {
  const expected = {
    targetSha: requireSha(expectedProvenance.targetSha, "expected target SHA"),
    workflowSha: requireSha(expectedProvenance.workflowSha, "expected workflow SHA"),
    runId: requireString(expectedProvenance.runId, "expected workflow run id"),
    runAttempt: requirePositiveInteger(
      expectedProvenance.runAttempt,
      "expected workflow run attempt",
    ),
    tooling: {
      xcode: requireString(expectedProvenance.tooling?.xcode, "expected Xcode version"),
      fastlane: requireString(expectedProvenance.tooling?.fastlane, "expected Fastlane version"),
      node: requireString(expectedProvenance.tooling?.node, "expected Node version"),
    },
  };
  const manifests = loadExpectedManifests(inputDirectory, expected.targetSha);
  const families = manifests
    .map(({ manifest }) => manifest.family)
    .toSorted((left, right) => left.localeCompare(right));
  if (families.join("\n") !== EXPECTED_FAMILIES.join("\n")) {
    fail(
      `screenshot family union mismatch; expected ${EXPECTED_FAMILIES.join(", ")}, found ${families.join(", ") || "none"}`,
    );
  }
  const canonicalEntries = [];
  for (const { manifestPath, manifest } of manifests) {
    if (manifest.schemaVersion !== 1) {
      fail(`unsupported screenshot manifest schema in ${manifestPath}`);
    }
    if (manifest.targetSha !== expected.targetSha) {
      fail(
        `cross-SHA screenshot evidence in ${manifestPath}: expected ${expected.targetSha}, found ${manifest.targetSha}`,
      );
    }
    if (manifest.workflowSha !== expected.workflowSha) {
      fail(`${manifest.family} workflow SHA does not match the reducer context`);
    }
    if (manifest.runId !== expected.runId) {
      fail(`${manifest.family} workflow run id does not match the reducer context`);
    }
    if (manifest.runAttempt !== expected.runAttempt) {
      fail(`${manifest.family} workflow run attempt does not match the reducer context`);
    }
    for (const tool of ["xcode", "fastlane", "node"]) {
      if (manifest.tooling?.[tool] !== expected.tooling[tool]) {
        fail(`${manifest.family} ${tool} version does not match the reducer context`);
      }
    }
    verifyManifestFamily(manifestPath, manifest);
    for (const screenshot of manifest.screenshots) {
      canonicalEntries.push({
        ...verifyManifestEntry(manifestPath, screenshot, "screenshot"),
        family: manifest.family,
      });
    }
    for (const attempt of manifest.captureAttempts) {
      if (attempt.artifactPath === null) {
        continue;
      }
      canonicalEntries.push({
        ...verifyManifestEntry(manifestPath, attempt, "xcresult"),
        family: manifest.family,
      });
    }
  }
  const canonicalPaths = canonicalEntries.map(({ canonicalPath }) => canonicalPath);
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    fail("duplicate canonical screenshot evidence paths");
  }

  const screenshotOutput = path.join(outputRoot, "apps/ios/fastlane/screenshots/en-US");
  const xcresultOutput = path.join(outputRoot, "apps/ios/build/SnapshotTestResults");
  const manifestOutput = path.join(outputRoot, "apps/ios/build/ScreenshotEvidence");
  for (const directory of [screenshotOutput, xcresultOutput, manifestOutput]) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const entry of canonicalEntries) {
    copyEntry(entry.source, path.join(outputRoot, entry.canonicalPath));
  }
  const combinedManifest = {
    schemaVersion: 1,
    attemptModel: { ...ATTEMPT_MODEL },
    ...expected,
    families: manifests
      .map(({ manifest }) => manifest)
      .toSorted((left, right) => left.family.localeCompare(right.family)),
  };
  fs.writeFileSync(
    path.join(manifestOutput, "manifest.json"),
    `${JSON.stringify(combinedManifest, null, 2)}\n`,
  );
  return combinedManifest;
}

function parseIosScreenshotEvidenceArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument list near ${key ?? "end of input"}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function main(argv) {
  const { command, options } = parseIosScreenshotEvidenceArgs(argv);
  if (command === "collect") {
    const manifest = collectIosScreenshotEvidence({
      family: options.family,
      screenshotDirectory: options.screenshots,
      xcresultDirectory: options.xcresults,
      outputDirectory: options.output,
      provenance: {
        targetSha: options["target-sha"],
        workflowSha: options["workflow-sha"],
        runId: options["run-id"],
        runAttempt: options["run-attempt"],
        tooling: {
          xcode: options["xcode-version"],
          fastlane: options["fastlane-version"],
          node: options["node-version"],
        },
      },
    });
    console.log(`collected ${manifest.family} screenshot evidence for ${manifest.targetSha}`);
    return;
  }
  if (command === "reduce") {
    const manifest = reduceIosScreenshotEvidence({
      inputDirectory: options.input,
      outputRoot: options.output,
      expectedProvenance: {
        targetSha: options["target-sha"],
        workflowSha: options["workflow-sha"],
        runId: options["run-id"],
        runAttempt: options["run-attempt"],
        tooling: {
          xcode: options["xcode-version"],
          fastlane: options["fastlane-version"],
          node: options["node-version"],
        },
      },
    });
    console.log(`reduced iOS screenshot evidence for ${manifest.targetSha}`);
    return;
  }
  fail(`expected command collect or reduce, got ${command ?? "none"}`);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[ios-screenshot-evidence] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
