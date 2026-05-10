import fs from "node:fs";
import { describe, expect, it } from "vitest";

type AcpxPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("acpx package manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as AcpxPackageManifest;

    expect(packageJson.dependencies?.acpx).toBeTypeOf("string");
    expect(packageJson.dependencies?.acpx).not.toBe("");
    expect(packageJson.dependencies?.["@zed-industries/codex-acp"]).toBe("0.14.0");
    expect(packageJson.dependencies?.["@agentclientprotocol/claude-agent-acp"]).toBe("0.33.1");
    expect(packageJson.devDependencies?.["@agentclientprotocol/claude-agent-acp"]).toBeUndefined();
  });
});
