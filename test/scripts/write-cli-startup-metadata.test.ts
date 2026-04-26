import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeCliStartupMetadata } from "../../scripts/write-cli-startup-metadata.ts";
import { createScriptTestHarness } from "./test-helpers.js";

describe("write-cli-startup-metadata", () => {
  const { createTempDir } = createScriptTestHarness();

  it("writes startup metadata with populated root help text when dist falls back to source rendering", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");

    mkdirSync(distDir, { recursive: true });
    mkdirSync(path.join(extensionsDir, "matrix"), { recursive: true });
    writeFileSync(
      path.join(extensionsDir, "matrix", "package.json"),
      JSON.stringify({
        openclaw: {
          channel: {
            id: "matrix",
            order: 120,
            label: "Matrix",
          },
        },
      }),
      "utf8",
    );

    await writeCliStartupMetadata({ distDir, outputPath, extensionsDir });

    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      browserHelpText: string;
      channelOptions: string[];
      rootHelpText: string;
    };
    expect(written.channelOptions).toContain("matrix");
    expect(written.browserHelpText).toContain("Usage:");
    expect(written.browserHelpText).toContain("openclaw browser");
    expect(written.rootHelpText).toContain("Usage:");
    expect(written.rootHelpText).toContain("openclaw");
  });
});
