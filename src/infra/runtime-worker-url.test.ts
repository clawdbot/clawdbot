import { describe, expect, it } from "vitest";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

describe("resolveRuntimeWorkerUrl", () => {
  it("resolves source siblings and stable packaged worker paths", () => {
    expect(
      resolveRuntimeWorkerUrl({
        currentModuleUrl: "file:///repo/src/agents/code-mode-worker.ts",
        sourceWorkerName: "code-mode.worker",
        distWorkerPath: "agents/code-mode.worker.js",
      }).pathname,
    ).toBe("/repo/src/agents/code-mode.worker.ts");

    for (const currentModuleUrl of [
      "file:///repo/dist/agents/code-mode.js",
      "file:///repo/dist/selection-abc123.js",
    ]) {
      expect(
        resolveRuntimeWorkerUrl({
          currentModuleUrl,
          sourceWorkerName: "code-mode.worker",
          distWorkerPath: "agents/code-mode.worker.js",
        }).pathname,
      ).toBe("/repo/dist/agents/code-mode.worker.js");
    }
  });
});
