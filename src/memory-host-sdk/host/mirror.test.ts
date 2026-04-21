import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HOST_DIR, "../../..");
const PACKAGE_HOST_DIR = path.join(REPO_ROOT, "packages/memory-host-sdk/src/host");

const PACKAGE_COVERED_MIRRORS = [
  "batch-output.ts",
  "batch-status.ts",
  "embedding-chunk-limits.ts",
  "embeddings-model-normalize.ts",
] as const;

describe("memory-host-sdk mirrored host modules", () => {
  it("keeps package-covered source mirrors byte-identical", () => {
    for (const fileName of PACKAGE_COVERED_MIRRORS) {
      const srcSource = fs.readFileSync(path.join(HOST_DIR, fileName), "utf8");
      const packageSource = fs.readFileSync(path.join(PACKAGE_HOST_DIR, fileName), "utf8");
      expect(srcSource, fileName).toBe(packageSource);
    }
  });
});
