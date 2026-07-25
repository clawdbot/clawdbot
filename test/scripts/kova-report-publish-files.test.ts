import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPublishedFileSizeLimit,
  copyBundleMetadata,
} from "../../scripts/lib/kova-report-publish-files.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);

describe("Kova report publish files", () => {
  it("publishes bundle metadata while leaving the full archive in the Actions artifact", () => {
    const root = tempRoots.make("openclaw-kova-publish-");
    const bundleDir = join(root, "artifact", "bundle");
    const destinationDir = join(root, "report", "bundles");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "bundle.json"), '{"schemaVersion":"kova.bundle.v1"}\n');
    writeFileSync(join(bundleDir, "bundle.tar.gz"), Buffer.alloc(200));
    writeFileSync(join(bundleDir, "bundle.tar.gz.sha256"), "abc  bundle.tar.gz\n");

    expect(copyBundleMetadata({ bundleDir, destinationDir })).toEqual([
      "bundle.json",
      "bundle.tar.gz.sha256",
    ]);
    expect(readdirSync(destinationDir).sort()).toEqual(["bundle.json", "bundle.tar.gz.sha256"]);
    expect(readFileSync(join(destinationDir, "bundle.tar.gz.sha256"), "utf8")).toBe(
      "abc  bundle.tar.gz\n",
    );
  });

  it("requires bundle metadata and a checksum", () => {
    const root = tempRoots.make("openclaw-kova-publish-");
    const bundleDir = join(root, "bundle");
    mkdirSync(bundleDir);
    writeFileSync(join(bundleDir, "bundle.tar.gz"), Buffer.alloc(1));

    expect(() =>
      copyBundleMetadata({ bundleDir, destinationDir: join(root, "destination") }),
    ).toThrow("Kova bundle metadata is missing bundle.json");

    writeFileSync(join(bundleDir, "bundle.json"), "{}\n");
    expect(() =>
      copyBundleMetadata({ bundleDir, destinationDir: join(root, "destination") }),
    ).toThrow("Kova bundle metadata is missing a checksum");
  });

  it("accepts the size boundary and rejects the first oversized published file", () => {
    const root = tempRoots.make("openclaw-kova-publish-");
    writeFileSync(join(root, "at-limit.json"), Buffer.alloc(100));

    expect(assertPublishedFileSizeLimit({ publishRoot: root, maxFileBytes: 100 })).toBe(1);

    writeFileSync(join(root, "oversized.json"), Buffer.alloc(101));
    expect(() => assertPublishedFileSizeLimit({ publishRoot: root, maxFileBytes: 100 })).toThrow(
      "oversized.json: 101 bytes exceeds 100",
    );
  });
});
