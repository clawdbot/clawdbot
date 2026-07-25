import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test-support.js";
import { buildCopilotRuntime } from "./build-copilot-runtime.mjs";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("scripts/build-copilot-runtime.mjs", () => {
  it("creates a missing bundle without rewriting it when unchanged", async () => {
    const rootDir = tempDirs.make("openclaw-browser-copilot-runtime-");
    const outputPath = path.join(rootDir, "copilot-runtime.js");
    const build = vi.fn(async () => ({
      outputFiles: [{ text: "export const copilotRuntime = true;\n" }],
    }));

    await expect(buildCopilotRuntime({ build, outputPath })).resolves.toBe(true);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("export const copilotRuntime = true;\n");

    const initialTime = new Date("2026-07-18T04:00:00.000Z");
    fs.utimesSync(outputPath, initialTime, initialTime);

    await expect(buildCopilotRuntime({ build, outputPath })).resolves.toBe(false);
    expect(fs.statSync(outputPath).mtimeMs).toBe(initialTime.getTime());
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        outfile: outputPath,
        minifyIdentifiers: false,
        write: false,
      }),
    );
  });

  it("matches the checked-in Chrome extension runtime", async () => {
    const rootDir = tempDirs.make("openclaw-browser-copilot-runtime-");
    const outputPath = path.join(rootDir, "copilot-runtime.js");
    const checkedInPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "chrome-extension",
      "modules",
      "copilot-runtime.js",
    );

    await expect(buildCopilotRuntime({ outputPath })).resolves.toBe(true);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(fs.readFileSync(checkedInPath, "utf8"));
  });
});
