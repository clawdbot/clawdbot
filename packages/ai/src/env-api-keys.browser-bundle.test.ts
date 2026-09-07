import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("env API key browser bundle", () => {
  it("does not emit a static node:fs require", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./env-api-keys.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      logLevel: "silent",
      platform: "browser",
      write: false,
    });

    const output = result.outputFiles[0]?.text ?? "";
    expect(output).not.toMatch(/(?:__)?require\(\s*["']node:fs["']\s*\)/u);
  });
});
