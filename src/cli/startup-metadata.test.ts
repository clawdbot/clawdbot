// Startup metadata tests cover CLI startup metadata collection and propagation.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { testing } from "./startup-metadata.test-support.js";

describe("startup metadata path resolution", () => {
  it("checks metadata beside the bundled chunk before the legacy parent path", () => {
    const moduleDir = path.resolve("dist");
    const moduleUrl = pathToFileURL(path.join(moduleDir, "root-help-metadata-abc123.js")).href;

    expect(testing.resolveStartupMetadataPathCandidates(moduleUrl)).toEqual([
      path.join(moduleDir, "cli-startup-metadata.json"),
      path.join(path.dirname(moduleDir), "cli-startup-metadata.json"),
    ]);
  });
});
