// Browser CLI cold-import tests keep selected commands off the broad Browser runtime barrel.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const browserExtensionRoot = fileURLToPath(new URL("../..", import.meta.url));

const coldBrowserCliFiles = [
  "src/cli/browser-cli.ts",
  "src/cli/browser-cli-manage.ts",
  "src/cli/browser-cli-shared.ts",
] as const;

describe("browser CLI cold imports", () => {
  it("keeps selected manage commands on focused SDK subpaths", () => {
    for (const file of coldBrowserCliFiles) {
      const source = fs.readFileSync(path.join(browserExtensionRoot, file), "utf8");
      expect(source, `${file} must use the narrow SDK and browser owners`).not.toMatch(
        /\bfrom\s+["'](?:\.\.\/|\.\/)(?:core-api|sdk-(?:config|node-runtime|setup-tools))\.js["']/,
      );
    }
  });
});
