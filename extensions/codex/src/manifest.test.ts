import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION } from "./app-server/version.js";

type CodexPackageManifest = {
  dependencies?: Record<string, string>;
};

describe("codex package manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as CodexPackageManifest;

    expect(packageJson.dependencies?.["@mariozechner/pi-coding-agent"]).toBeDefined();
    expect(packageJson.dependencies?.["@openai/codex"]).toBe(
      MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION,
    );
  });
});
