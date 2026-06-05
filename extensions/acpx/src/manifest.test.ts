// ACPX tests cover manifest plugin behavior.
import fs from "node:fs";
import { describe, expect, it } from "vitest";

type AcpxPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as AcpxPackageManifest;

describe("acpx package manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    expect(packageJson.dependencies?.acpx).toBeTypeOf("string");
    expect(packageJson.dependencies?.acpx).not.toBe("");
    expect(packageJson.dependencies?.["@zed-industries/codex-acp"]).toBe("0.15.0");
    expect(packageJson.dependencies?.["@agentclientprotocol/claude-agent-acp"]).toBe("0.39.0");
    expect(packageJson.devDependencies?.["@agentclientprotocol/claude-agent-acp"]).toBeUndefined();
  });
});
