#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
    xcresults: true,
  },
  "ipad-13": {
    devicePattern: /^iPad (?:Air|Pro) 13-inch/u,
    screenshotNames: SCREENSHOT_NAMES,
    xcresults: true,
  },
  watch: {
    devicePattern: /^Apple Watch/u,
    screenshotNames: ["01-now-face"],
    xcresults: false,
  },
};
const EXPECTED_FAMILIES = Object.keys(FAMILY_SPECS).toSorted();

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
      result: requireString(summary.result, `${resultPath} result`),
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

function collectXcresults({
  deviceName,
  familyDirectory,
  screenshotNames,
  xcresultDirectory,
  readXcresultSummary,
}) {
  const entries = listEntries(xcresultDirectory)
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcresult"))
    .map((entry) => entry.name);
  const results = [];
  for (const screenshotName of screenshotNames) {
    const pattern = new RegExp(
      `^${deviceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-${screenshotName}-attempt-(1|2)\\.xcresult$`,
      "u",
    );
    const attempts = entries
      .map((name) => {
        const match = name.match(pattern);
        return match ? { attempt: Number(match[1]), name } : undefined;
      })
      .filter(Boolean)
      .toSorted((left, right) => left.attempt - right.attempt);
    const attemptNumbers = attempts.map(({ attempt }) => attempt).join(",");
    if (attemptNumbers !== "1" && attemptNumbers !== "1,2") {
      fail(
        `${deviceName} ${screenshotName} expected attempt 1 and optional retry 2; found ${attemptNumbers || "none"}`,
      );
    }
    const summaries = attempts.map(({ attempt, name }) => {
      const source = path.join(xcresultDirectory, name);
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
        result: summary.result,
        failedTests: summary.failedTests,
        sha256: sha256Directory(source),
      };
    });
    const final = summaries.at(-1);
    if (final.result !== "Passed" || final.failedTests !== 0) {
      fail(`${final.artifactPath} is not a passing final attempt`);
    }
    if (
      summaries.length === 2 &&
      summaries[0].result === "Passed" &&
      summaries[0].failedTests === 0
    ) {
      fail(`${summaries[0].artifactPath} is an unexpected passing retry predecessor`);
    }
    results.push(...summaries);
  }
  const expectedNames = results.map(({ artifactPath }) => path.posix.basename(artifactPath));
  const familyEntries = entries.filter((name) => name.startsWith(`${deviceName}-`));
  if (
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
  const xcresults = spec.xcresults
    ? collectXcresults({
        deviceName,
        familyDirectory,
        screenshotNames: spec.screenshotNames,
        xcresultDirectory,
        readXcresultSummary,
      })
    : [];
  const manifest = {
    schemaVersion: 1,
    family,
    deviceName,
    ...normalizedProvenance,
    screenshots,
    xcresults,
  };
  fs.writeFileSync(
    path.join(familyDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function findManifestPaths(directory) {
  return listFilesRecursive(directory)
    .filter(({ relativePath }) => {
      const segments = relativePath.split("/");
      return (
        segments.at(-1) === "manifest.json" &&
        !segments.some((segment) => segment.endsWith(".xcresult"))
      );
    })
    .map(({ absolutePath }) => absolutePath);
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
  const expectedTopLevel = ["manifest.json", "screenshots"];
  if (manifest.xcresults.length > 0) {
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

  if (manifest.xcresults.length > 0) {
    const expectedXcresults = manifest.xcresults
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

function verifyManifestFamily(manifestPath, manifest) {
  const spec = FAMILY_SPECS[manifest.family];
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

  if (!spec.xcresults) {
    if (manifest.xcresults?.length !== 0) {
      fail(`${manifest.family} must not contain xcresult evidence`);
    }
    verifyFamilyArtifactUnion(manifestPath, manifest);
    return;
  }
  const knownXcresultNames = new Set(spec.screenshotNames);
  if (manifest.xcresults.some((entry) => !knownXcresultNames.has(entry.screenshotName))) {
    fail(`${manifest.family} xcresult union contains an unexpected screenshot`);
  }
  for (const screenshotName of spec.screenshotNames) {
    const attempts = manifest.xcresults
      ?.filter((entry) => entry.screenshotName === screenshotName)
      .toSorted((left, right) => left.attempt - right.attempt);
    const attemptNumbers = attempts?.map((entry) => entry.attempt).join(",");
    if (attemptNumbers !== "1" && attemptNumbers !== "1,2") {
      fail(`${manifest.family} ${screenshotName} xcresult attempt union mismatch`);
    }
    const final = attempts.at(-1);
    if (final.result !== "Passed" || final.failedTests !== 0) {
      fail(`${manifest.family} ${screenshotName} final xcresult is not passing`);
    }
    if (attempts.length === 2 && attempts[0].result === "Passed" && attempts[0].failedTests === 0) {
      fail(`${manifest.family} ${screenshotName} retry predecessor unexpectedly passed`);
    }
    for (const attempt of attempts) {
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

export function reduceIosScreenshotEvidence({ inputDirectory, outputRoot, targetSha }) {
  const expectedTargetSha = requireSha(targetSha, "expected target SHA");
  const manifestPaths = findManifestPaths(inputDirectory);
  const manifests = manifestPaths.map((manifestPath) => ({
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  }));
  const families = manifests.map(({ manifest }) => manifest.family).toSorted();
  if (families.join("\n") !== EXPECTED_FAMILIES.join("\n")) {
    fail(
      `screenshot family union mismatch; expected ${EXPECTED_FAMILIES.join(", ")}, found ${families.join(", ") || "none"}`,
    );
  }
  const runIdentities = new Set();
  const toolingIdentities = new Set();
  const canonicalEntries = [];
  for (const { manifestPath, manifest } of manifests) {
    if (manifest.schemaVersion !== 1) {
      fail(`unsupported screenshot manifest schema in ${manifestPath}`);
    }
    if (manifest.targetSha !== expectedTargetSha) {
      fail(
        `cross-SHA screenshot evidence in ${manifestPath}: expected ${expectedTargetSha}, found ${manifest.targetSha}`,
      );
    }
    requireSha(manifest.workflowSha, `${manifest.family} workflow SHA`);
    runIdentities.add(`${manifest.runId}:${manifest.runAttempt}:${manifest.workflowSha}`);
    toolingIdentities.add(JSON.stringify(manifest.tooling));
    verifyManifestFamily(manifestPath, manifest);
    for (const screenshot of manifest.screenshots) {
      canonicalEntries.push({
        ...verifyManifestEntry(manifestPath, screenshot, "screenshot"),
        family: manifest.family,
      });
    }
    for (const xcresult of manifest.xcresults) {
      canonicalEntries.push({
        ...verifyManifestEntry(manifestPath, xcresult, "xcresult"),
        family: manifest.family,
      });
    }
  }
  if (runIdentities.size !== 1) {
    fail(`cross-run screenshot evidence: ${[...runIdentities].join(", ")}`);
  }
  if (toolingIdentities.size !== 1) {
    fail(`cross-tooling screenshot evidence: ${[...toolingIdentities].join(", ")}`);
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
    targetSha: expectedTargetSha,
    runIdentity: [...runIdentities][0],
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

export function parseIosScreenshotEvidenceArgs(argv) {
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
      targetSha: options["target-sha"],
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
