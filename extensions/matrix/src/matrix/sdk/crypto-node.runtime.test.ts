import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const sdkDir = path.dirname(fileURLToPath(import.meta.url));
const cryptoNodeRuntimePath = path.join(sdkDir, "crypto-node.runtime.ts");

describe("crypto-node runtime bundling", () => {
  it("keeps the native Matrix crypto package behind a runtime require boundary", async () => {
    const result = await build({
      entryPoints: [cryptoNodeRuntimePath],
      bundle: true,
      external: ["@matrix-org/matrix-sdk-crypto-nodejs"],
      format: "esm",
      platform: "node",
      write: false,
    });

    const bundled = result.outputFiles.at(0)?.text ?? "";

    expect(bundled).toContain('from "node:module"');
    expect(bundled).toContain("createRequire(import.meta.url)");
    expect(bundled).toMatch(
      /function loadMatrixCryptoNodeBindings\(\) \{[\s\S]*require\d*\("@matrix-org\/matrix-sdk-crypto-nodejs"\)/,
    );
    expect(bundled).not.toContain('from "@matrix-org/matrix-sdk-crypto-nodejs"');
  });
});
