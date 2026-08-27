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
const ATTEMPT_MODEL = {
  owner: "openclaw",
  unit: "capture_ios_screenshots invocation",
  maxAttempts: 2,
  fastlaneInternalRetries: "workflow-log",
};
type Family = "iphone" | "ipad-13" | "watch";

function provenance(targetSha = TARGET_SHA) {
  return {
    targetSha,
    workflowSha: WORKFLOW_SHA,
    runId: "12345",
    runAttempt: 2,
    tooling: {
      xcode: "Xcode 26.6 Build version 17F113",
      fastlane: "2.236.1",
      node: "v24.16.0",
    },
  };
}

function writeFamilySource(
  root: string,
  family: Family,
  options: {
    retry?: string;
    retryTestResult?: "fail" | "pass";
    retryWithoutXcresult?: boolean;
  } = {},
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
  const captureAttempts = [];
  for (const name of names) {
    fs.writeFileSync(path.join(screenshots, `${device}-${name}.png`), PNG);
    if (family !== "watch") {
      const retried = options.retry === name;
      captureAttempts.push({
        deviceName: device,
        screenshotName: name,
        attempt: 1,
        captureOutcome: retried ? "failed" : "succeeded",
      });
      if (!(retried && options.retryWithoutXcresult)) {
        const attemptOne = path.join(xcresults, `${device}-${name}-attempt-1.xcresult`);
        fs.mkdirSync(attemptOne, { recursive: true });
        fs.writeFileSync(
          path.join(attemptOne, "summary.txt"),
          retried ? (options.retryTestResult ?? "pass") : "pass",
        );
      }
      if (options.retry === name) {
        captureAttempts.push({
          deviceName: device,
          screenshotName: name,
          attempt: 2,
          captureOutcome: "succeeded",
        });
        const attemptTwo = path.join(xcresults, `${device}-${name}-attempt-2.xcresult`);
        fs.mkdirSync(attemptTwo, { recursive: true });
        fs.writeFileSync(path.join(attemptTwo, "summary.txt"), "pass");
      }
    }
  }
  if (family !== "watch") {
    fs.writeFileSync(
      path.join(xcresults, "capture-attempts.json"),
      JSON.stringify({ schemaVersion: 1, attempts: captureAttempts }),
    );
  }
  return { device, screenshots, xcresults };
}

function containerName(family: Family, targetSha = TARGET_SHA) {
  const shard = family === "watch" ? "iphone" : family;
  return `ios-release-screenshot-shard-${shard}-${targetSha}`;
}

function familyDirectory(input: string, family: Family, targetSha = TARGET_SHA) {
  return path.join(input, containerName(family, targetSha), family);
}

function manifestPath(input: string, family: Family, targetSha = TARGET_SHA) {
  return path.join(familyDirectory(input, family, targetSha), "manifest.json");
}

function collectAll(
  root: string,
  targetSha = TARGET_SHA,
  options: { retryWithoutXcresult?: boolean } = {},
) {
  const output = path.join(root, "collected");
  for (const family of ["iphone", "ipad-13", "watch"] as const) {
    const source = writeFamilySource(root, family, {
      retry: family === "iphone" ? "02-chat-connected" : undefined,
      retryWithoutXcresult: family === "iphone" && options.retryWithoutXcresult,
    });
    collectIosScreenshotEvidence({
      family,
      screenshotDirectory: source.screenshots,
      xcresultDirectory: source.xcresults,
      outputDirectory: path.join(output, containerName(family, targetSha)),
      provenance: provenance(targetSha),
      readXcresultSummary: (resultPath) => {
        const result = fs.readFileSync(path.join(resultPath, "summary.txt"), "utf8");
        return result === "pass"
          ? { testResult: "Passed", failedTests: 0 }
          : { testResult: "Failed", failedTests: 1 };
      },
    });
  }
  return output;
}

function reduceAll(input: string, outputRoot: string, expected = provenance()) {
  return reduceIosScreenshotEvidence({
    inputDirectory: input,
    outputRoot,
    expectedProvenance: expected,
  });
}

function updateManifest(
  input: string,
  family: Family,
  mutate: (manifest: Record<string, any>) => void,
) {
  const filePath = manifestPath(input, family);
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(manifest);
  fs.writeFileSync(filePath, JSON.stringify(manifest));
}

function updateAllManifests(input: string, mutate: (manifest: Record<string, any>) => void) {
  for (const family of ["iphone", "ipad-13", "watch"] as const) {
    updateManifest(input, family, mutate);
  }
}

describe("iOS screenshot evidence", () => {
  it("reduces the exact device union and models passed retry xcresults by capture outcome", () => {
    const root = tempDirs.make("ios-screenshot-evidence-");
    const input = collectAll(root);
    const output = path.join(root, "reduced");

    const manifest = reduceAll(input, output);
    const iphoneManifest = JSON.parse(fs.readFileSync(manifestPath(input, "iphone"), "utf8"));
    const retryAttempts = iphoneManifest.captureAttempts.filter(
      (entry: { screenshotName: string }) => entry.screenshotName === "02-chat-connected",
    );

    expect(manifest.targetSha).toBe(TARGET_SHA);
    expect(manifest.attemptModel).toEqual(ATTEMPT_MODEL);
    expect(retryAttempts.map((entry: { captureOutcome: string }) => entry.captureOutcome)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(retryAttempts.map((entry: { testResult: string }) => entry.testResult)).toEqual([
      "Passed",
      "Passed",
    ]);
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

  it("accepts a failed first invocation without an xcresult before a passing retry", () => {
    const root = tempDirs.make("ios-screenshot-missing-retry-xcresult-");
    const input = collectAll(root, TARGET_SHA, { retryWithoutXcresult: true });
    const output = path.join(root, "reduced");

    reduceAll(input, output);
    const iphoneManifest = JSON.parse(fs.readFileSync(manifestPath(input, "iphone"), "utf8"));
    const retryAttempts = iphoneManifest.captureAttempts.filter(
      (entry: { screenshotName: string }) => entry.screenshotName === "02-chat-connected",
    );

    expect(
      retryAttempts.map(
        (entry: { attempt: number; captureOutcome: string; artifactPath: string | null }) => ({
          attempt: entry.attempt,
          captureOutcome: entry.captureOutcome,
          artifactPath: entry.artifactPath,
        }),
      ),
    ).toEqual([
      { attempt: 1, captureOutcome: "failed", artifactPath: null },
      {
        attempt: 2,
        captureOutcome: "succeeded",
        artifactPath: "xcresults/iPhone 17 Pro Max-02-chat-connected-attempt-2.xcresult",
      },
    ]);
    expect(
      fs.existsSync(
        path.join(
          output,
          "apps/ios/build/SnapshotTestResults",
          "iPhone 17 Pro Max-02-chat-connected-attempt-1.xcresult",
        ),
      ),
    ).toBe(false);
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

  it("requires the successful final invocation to have a passing xcresult", () => {
    const root = tempDirs.make("ios-screenshot-missing-final-xcresult-");
    const source = writeFamilySource(root, "iphone", { retry: "02-chat-connected" });
    fs.rmSync(
      path.join(source.xcresults, `${source.device}-02-chat-connected-attempt-2.xcresult`),
      { recursive: true },
    );

    expect(() =>
      collectIosScreenshotEvidence({
        family: "iphone",
        screenshotDirectory: source.screenshots,
        xcresultDirectory: source.xcresults,
        outputDirectory: path.join(root, "collected"),
        provenance: provenance(),
        readXcresultSummary: () => ({ testResult: "Passed", failedTests: 0 }),
      }),
    ).toThrow("is missing for the successful final capture attempt");
  });

  it.each([
    {
      label: "extra",
      mutate: (input: string) =>
        fs.cpSync(
          path.join(input, containerName("ipad-13")),
          path.join(input, `ios-release-screenshot-shard-extra-${TARGET_SHA}`),
          { recursive: true },
        ),
    },
    {
      label: "renamed",
      mutate: (input: string) =>
        fs.renameSync(
          path.join(input, containerName("iphone")),
          path.join(input, `ios-release-screenshot-shard-renamed-${TARGET_SHA}`),
        ),
    },
    {
      label: "missing",
      mutate: (input: string) =>
        fs.rmSync(path.join(input, containerName("ipad-13")), { recursive: true }),
    },
    {
      label: "swapped",
      mutate: (input: string) => {
        const iphone = path.join(input, containerName("iphone"));
        const ipad = path.join(input, containerName("ipad-13"));
        const temporary = path.join(input, "temporary-container");
        fs.renameSync(iphone, temporary);
        fs.renameSync(ipad, iphone);
        fs.renameSync(temporary, ipad);
      },
    },
  ])("rejects $label artifact container topology", ({ mutate }) => {
    const root = tempDirs.make("ios-screenshot-topology-");
    const input = collectAll(root);
    mutate(input);

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(/topology mismatch/u);
  });

  it("rejects cross-SHA shard evidence", () => {
    const root = tempDirs.make("ios-screenshot-cross-sha-");
    const input = collectAll(root);
    updateManifest(input, "ipad-13", (manifest) => {
      manifest.targetSha = "c".repeat(40);
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "cross-SHA screenshot evidence",
    );
  });

  it.each([
    {
      label: "workflow SHA",
      mutate: (manifest: Record<string, any>) => {
        manifest.workflowSha = "c".repeat(40);
      },
      error: "workflow SHA",
    },
    {
      label: "run id",
      mutate: (manifest: Record<string, any>) => {
        manifest.runId = "99999";
      },
      error: "workflow run id",
    },
    {
      label: "run attempt",
      mutate: (manifest: Record<string, any>) => {
        manifest.runAttempt = 3;
      },
      error: "workflow run attempt",
    },
    {
      label: "Xcode version",
      mutate: (manifest: Record<string, any>) => {
        manifest.tooling.xcode = "Xcode 26.6 Build version forged";
      },
      error: "xcode version",
    },
    {
      label: "Fastlane version",
      mutate: (manifest: Record<string, any>) => {
        manifest.tooling.fastlane = "2.236.0";
      },
      error: "fastlane version",
    },
    {
      label: "Node version",
      mutate: (manifest: Record<string, any>) => {
        manifest.tooling.node = "v24.0.0";
      },
      error: "node version",
    },
  ])("rejects self-consistent forged $label", ({ mutate, error }) => {
    const root = tempDirs.make("ios-screenshot-forged-provenance-");
    const input = collectAll(root);
    updateAllManifests(input, mutate);

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(error);
  });

  it.each([
    {
      label: "missing",
      mutate: (manifest: Record<string, any>) => {
        delete manifest.attemptModel;
      },
    },
    {
      label: "owner",
      mutate: (manifest: Record<string, any>) => {
        manifest.attemptModel.owner = "fastlane";
      },
    },
    {
      label: "unit",
      mutate: (manifest: Record<string, any>) => {
        manifest.attemptModel.unit = "launch retry";
      },
    },
    {
      label: "maximum",
      mutate: (manifest: Record<string, any>) => {
        manifest.attemptModel.maxAttempts = 3;
      },
    },
    {
      label: "Fastlane retry ownership",
      mutate: (manifest: Record<string, any>) => {
        manifest.attemptModel.fastlaneInternalRetries = "xcresult";
      },
    },
  ])("rejects $label attempt model changes", ({ mutate }) => {
    const root = tempDirs.make("ios-screenshot-attempt-model-");
    const input = collectAll(root);
    updateManifest(input, "iphone", mutate);

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow("unexpected attempt model");
  });

  it("rejects changed PNG bytes after collection", () => {
    const root = tempDirs.make("ios-screenshot-digest-");
    const input = collectAll(root);
    const screenshot = path.join(
      familyDirectory(input, "watch"),
      "screenshots",
      "Apple Watch Ultra 3 (49mm)-01-now-face.png",
    );
    fs.appendFileSync(screenshot, "changed");

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "screenshot digest mismatch",
    );
  });

  it("rejects changed xcresult bytes after collection", () => {
    const root = tempDirs.make("ios-screenshot-xcresult-digest-");
    const input = collectAll(root);
    fs.appendFileSync(
      path.join(
        familyDirectory(input, "iphone"),
        "xcresults",
        "iPhone 17 Pro Max-01-control-connected-attempt-1.xcresult",
        "summary.txt",
      ),
      "changed",
    );

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow("xcresult digest mismatch");
  });

  it("rejects a non-passing final capture attempt", () => {
    const root = tempDirs.make("ios-screenshot-final-failure-");
    const input = collectAll(root);
    updateManifest(input, "ipad-13", (manifest) => {
      const final = manifest.captureAttempts.find(
        (entry: { screenshotName: string }) => entry.screenshotName === "01-control-connected",
      );
      final.testResult = "Failed";
      final.failedTests = 1;
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "final xcresult is not passing",
    );
  });

  it("rejects a successful capture predecessor before attempt two", () => {
    const root = tempDirs.make("ios-screenshot-predecessor-");
    const input = collectAll(root);
    updateManifest(input, "iphone", (manifest) => {
      const predecessor = manifest.captureAttempts.find(
        (entry: { attempt: number; screenshotName: string }) =>
          entry.screenshotName === "02-chat-connected" && entry.attempt === 1,
      );
      predecessor.captureOutcome = "succeeded";
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "unexpected capture outcome sequence",
    );
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
        readXcresultSummary: () => ({ testResult: "Passed", failedTests: 0 }),
      }),
    ).toThrow("PNG union mismatch");
  });

  it("rejects unexpected capture attempt entries in a shard manifest", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-xcresult-");
    const input = collectAll(root);
    updateManifest(input, "iphone", (manifest) => {
      manifest.captureAttempts.push({
        ...manifest.captureAttempts[0],
        screenshotName: "99-unexpected",
      });
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "capture attempt union contains an unexpected screenshot",
    );
  });

  it("rejects unexpected files in a collected shard", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-file-");
    const input = collectAll(root);
    fs.writeFileSync(path.join(familyDirectory(input, "watch"), "unexpected.txt"), "unexpected");

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "shard contains unexpected evidence",
    );
  });

  it("rejects artifact paths outside the declared family directory", () => {
    const root = tempDirs.make("ios-screenshot-artifact-path-");
    const input = collectAll(root);
    updateManifest(input, "watch", (manifest) => {
      manifest.screenshots[0].artifactPath = "../iphone/manifest.json";
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "unexpected screenshot artifact path",
    );
  });
});
