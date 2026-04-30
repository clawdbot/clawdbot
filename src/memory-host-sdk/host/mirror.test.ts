import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));

const PACKAGE_BRIDGE_FILES = [
  "backend-config.ts",
  "batch-error-utils.ts",
  "batch-output.ts",
  "batch-status.ts",
  "embedding-input-limits.ts",
  "embeddings-remote-provider.ts",
  "embeddings.ts",
  "internal.ts",
  "memory-schema.ts",
  "multimodal.ts",
  "qmd-process.ts",
  "qmd-scope.ts",
  "query-expansion.ts",
  "read-file-shared.ts",
  "read-file.ts",
  "session-files.ts",
  "types.ts",
] as const;

describe("memory-host-sdk host package bridges", () => {
  it("keeps package-owned source bridges thin", () => {
    for (const fileName of PACKAGE_BRIDGE_FILES) {
      const source = fs.readFileSync(path.join(HOST_DIR, fileName), "utf8");
      expect(source, fileName).toBe(
        `export * from "../../../packages/memory-host-sdk/src/host/${fileName.replace(
          /\.ts$/u,
          ".js",
        )}";\n`,
      );
    }
  });
});
