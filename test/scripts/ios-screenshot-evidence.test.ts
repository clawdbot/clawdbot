import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectIosScreenshotEvidence,
  reduceIosScreenshotEvidence,
} from "../../scripts/ios-screenshot-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TARGET_SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fixture"),
]);
const SCREENSHOTS = [
  "01-control-connected",
  "02-chat-connected",
  "03-agent-connected",
  "04-settings-connected",
];

function provenance(targetSha = TARGET_SHA) {
  return {
    targetSha,
    workflowSha: WORKFLOW_SHA,
    runId: "12345",
    runAttempt: 2,
    tooling: {
      xcode: "Xcode 26.5 Build version 17F45",
      fastlane: "2.236.1",
      node: "v26.5.0",
    },
  };
}

function writeFamilySource(
  root: string,
  family: "iphone" | "ipad-13" | "watch",
  options: { retry?: string } = {},
) {
  const screenshots = path.join(root, family, "screenshots");
  const xcresults = path.join(root, family, "xcresults");
  fs.mkdirSync(screenshots, { recursive: true });
  fs.mkdirSync(xcresults, { recursive: true });
  const device =
    family === "iphone"
      ? "iPhone 17 Pro Max"
      : family === "ipad-13"
        ? "iPad Pro 13-inch (M5)"
        : "Apple Watch Ultra 3 (49mm)";
  const names = family === "watch" ? ["01-now-face"] : SCREENSHOTS;
  for (const name of names) {
    fs.writeFileSync(path.join(screenshots, `${device}-${name}.png`), PNG);
    if (family !== "watch") {
      const attemptOne = path.join(xcresults, `${device}-${name}-attempt-1.xcresult`);
      fs.mkdirSync(attemptOne, { recursive: true });
      fs.writeFileSync(
        path.join(attemptOne, "summary.txt"),
        options.retry === name ? "fail" : "pass",
      );
      if (options.retry === name) {
        const attemptTwo = path.join(xcresults, `${device}-${name}-attempt-2.xcresult`);
        fs.mkdirSync(attemptTwo, { recursive: true });
        fs.writeFileSync(path.join(attemptTwo, "summary.txt"), "pass");
      }
    }
  }
  return { device, screenshots, xcresults };
}

function collectAll(root: string, targetSha = TARGET_SHA) {
  const output = path.join(root, "collected");
  for (const family of ["iphone", "ipad-13", "watch"] as const) {
    const source = writeFamilySource(root, family, {
      retry: family === "iphone" ? "02-chat-connected" : undefined,
    });
    collectIosScreenshotEvidence({
      family,
      screenshotDirectory: source.screenshots,
      xcresultDirectory: source.xcresults,
      outputDirectory: output,
      provenance: provenance(targetSha),
      readXcresultSummary: (resultPath) => {
        const result = fs.readFileSync(path.join(resultPath, "summary.txt"), "utf8");
        return result === "pass"
          ? { result: "Passed", failedTests: 0 }
          : { result: "Failed", failedTests: 1 };
      },
    });
  }
  return output;
}

describe("iOS screenshot evidence", () => {
  it("reduces the exact device union and preserves failed retry evidence", () => {
    const root = tempDirs.make("ios-screenshot-evidence-");
    const input = collectAll(root);
    const output = path.join(root, "reduced");

    const manifest = reduceIosScreenshotEvidence({
      inputDirectory: input,
      outputRoot: output,
      targetSha: TARGET_SHA,
    });

    expect(manifest.targetSha).toBe(TARGET_SHA);
    expect(fs.readdirSync(path.join(output, "apps/ios/fastlane/screenshots/en-US"))).toHaveLength(
      9,
    );
    expect(
      fs.existsSync(
        path.join(
          output,
          "apps/ios/build/SnapshotTestResults",
          "iPhone 17 Pro Max-02-chat-connected-attempt-1.xcresult",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          output,
          "apps/ios/build/SnapshotTestResults",
          "iPhone 17 Pro Max-02-chat-connected-attempt-2.xcresult",
        ),
      ),
    ).toBe(true);
  });

  it("rejects cross-SHA shard evidence", () => {
    const root = tempDirs.make("ios-screenshot-cross-sha-");
    const input = collectAll(root);
    const ipadManifestPath = path.join(input, "ipad-13", "manifest.json");
    const ipadManifest = JSON.parse(fs.readFileSync(ipadManifestPath, "utf8"));
    ipadManifest.targetSha = "c".repeat(40);
    fs.writeFileSync(ipadManifestPath, JSON.stringify(ipadManifest));

    expect(() =>
      reduceIosScreenshotEvidence({
        inputDirectory: input,
        outputRoot: path.join(root, "reduced"),
        targetSha: TARGET_SHA,
      }),
    ).toThrow("cross-SHA screenshot evidence");
  });

  it("rejects duplicate family manifests", () => {
    const root = tempDirs.make("ios-screenshot-duplicate-");
    const input = collectAll(root);
    fs.cpSync(path.join(input, "iphone"), path.join(input, "iphone-copy"), {
      recursive: true,
    });

    expect(() =>
      reduceIosScreenshotEvidence({
        inputDirectory: input,
        outputRoot: path.join(root, "reduced"),
        targetSha: TARGET_SHA,
      }),
    ).toThrow("screenshot family union mismatch");
  });

  it("rejects changed PNG bytes after collection", () => {
    const root = tempDirs.make("ios-screenshot-digest-");
    const input = collectAll(root);
    const screenshot = path.join(
      input,
      "watch",
      "screenshots",
      "Apple Watch Ultra 3 (49mm)-01-now-face.png",
    );
    fs.appendFileSync(screenshot, "changed");

    expect(() =>
      reduceIosScreenshotEvidence({
        inputDirectory: input,
        outputRoot: path.join(root, "reduced"),
        targetSha: TARGET_SHA,
      }),
    ).toThrow("screenshot digest mismatch");
  });

  it("rejects an invalid PNG signature before collection", () => {
    const root = tempDirs.make("ios-screenshot-signature-");
    const source = writeFamilySource(root, "watch");
    fs.writeFileSync(
      path.join(source.screenshots, `${source.device}-01-now-face.png`),
      "not a png",
    );

    expect(() =>
      collectIosScreenshotEvidence({
        family: "watch",
        screenshotDirectory: source.screenshots,
        xcresultDirectory: source.xcresults,
        outputDirectory: path.join(root, "collected"),
        provenance: provenance(),
      }),
    ).toThrow("invalid PNG signature");
  });

  it("rejects unexpected screenshots in a device shard", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-");
    const source = writeFamilySource(root, "iphone");
    fs.writeFileSync(path.join(source.screenshots, `${source.device}-99-unexpected.png`), PNG);

    expect(() =>
      collectIosScreenshotEvidence({
        family: "iphone",
        screenshotDirectory: source.screenshots,
        xcresultDirectory: source.xcresults,
        outputDirectory: path.join(root, "collected"),
        provenance: provenance(),
        readXcresultSummary: () => ({ result: "Passed", failedTests: 0 }),
      }),
    ).toThrow("PNG union mismatch");
  });

  it("rejects unexpected xcresult entries in a shard manifest", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-xcresult-");
    const input = collectAll(root);
    const manifestPath = path.join(input, "iphone", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.xcresults.push({
      ...manifest.xcresults[0],
      screenshotName: "99-unexpected",
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() =>
      reduceIosScreenshotEvidence({
        inputDirectory: input,
        outputRoot: path.join(root, "reduced"),
        targetSha: TARGET_SHA,
      }),
    ).toThrow("xcresult union contains an unexpected screenshot");
  });

  it("rejects unexpected files in a collected shard", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-file-");
    const input = collectAll(root);
    fs.writeFileSync(path.join(input, "watch", "unexpected.txt"), "unexpected");

    expect(() =>
      reduceIosScreenshotEvidence({
        inputDirectory: input,
        outputRoot: path.join(root, "reduced"),
        targetSha: TARGET_SHA,
      }),
    ).toThrow("shard contains unexpected evidence");
  });

  it("rejects artifact paths outside the declared family directory", () => {
    const root = tempDirs.make("ios-screenshot-artifact-path-");
    const input = collectAll(root);
    const manifestPath = path.join(input, "watch", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.screenshots[0].artifactPath = "../iphone/manifest.json";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() =>
      reduceIosScreenshotEvidence({
        inputDirectory: input,
        outputRoot: path.join(root, "reduced"),
        targetSha: TARGET_SHA,
      }),
    ).toThrow("unexpected screenshot artifact path");
  });
});
