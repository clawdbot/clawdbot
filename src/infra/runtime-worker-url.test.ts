import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

describe("resolveRuntimeWorkerUrl", () => {
  it("resolves source siblings and stable packaged worker paths", () => {
    const root = path.resolve("worker-fixture-root");
    expect(
      fileURLToPath(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: pathToFileURL(path.join(root, "src/agents/code-mode-worker.ts")).href,
          sourceWorkerName: "code-mode.worker",
          distWorkerPath: "agents/code-mode.worker.js",
        }),
      ),
    ).toBe(path.join(root, "src/agents/code-mode.worker.ts"));

    for (const currentModuleUrl of [
      pathToFileURL(path.join(root, "dist/agents/code-mode.js")).href,
      pathToFileURL(path.join(root, "dist/selection-abc123.js")).href,
      pathToFileURL(path.join(root, "dist/selection-abc123.mjs")).href,
    ]) {
      expect(
        fileURLToPath(
          resolveRuntimeWorkerUrl({
            currentModuleUrl,
            sourceWorkerName: "code-mode.worker",
            distWorkerPath: "agents/code-mode.worker.js",
          }),
        ),
      ).toBe(path.join(root, "dist/agents/code-mode.worker.js"));
      const candidateRoot = path.join(root, "candidate");
      expect(
        fileURLToPath(
          resolveRuntimeWorkerUrl({
            currentModuleUrl,
            sourceWorkerName: "code-mode.worker",
            distWorkerPath: "agents/code-mode.worker.js",
            root: candidateRoot,
          }),
        ),
      ).toBe(path.join(candidateRoot, "dist/agents/code-mode.worker.js"));
    }
  });
});

describe("resolveRuntimeWorkerArgv", () => {
  it.each([
    { runtime: "/usr/bin/node", typescriptLoader: true },
    { runtime: "C:\\Program Files\\nodejs\\node.exe", typescriptLoader: true },
    { runtime: "/opt/homebrew/bin/bun", typescriptLoader: false },
    { runtime: "C:\\Program Files\\Bun\\bun.exe", typescriptLoader: false },
  ])("uses the source loader appropriate for $runtime", ({ runtime, typescriptLoader }) => {
    for (const extension of ["ts", "mts", "cts", "js", "mjs"]) {
      const url = pathToFileURL(path.resolve(`worker fixture.${extension}`));
      const loader = typescriptLoader && extension.endsWith("ts") ? ["--import", "tsx"] : [];
      expect(resolveRuntimeWorkerArgv(url, runtime)).toEqual([...loader, fileURLToPath(url)]);
    }
  });
});

describe("resolveRuntimeProcessEntrypointUrl", () => {
  it("uses canonical launchers unless the sealed bundle registers a sibling", async () => {
    vi.resetModules();
    try {
      const { registerSealedRuntimeProcessEntrypoint, resolveRuntimeProcessEntrypointUrl } =
        await import("./runtime-process-url.js");
      const { runtimeProcessEntrypoints } = await import("./runtime-process-entrypoints.js");
      expect(resolveRuntimeProcessEntrypointUrl("githubExec")).toEqual(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.githubExec),
      );
      const sqliteUrl = resolveRuntimeProcessEntrypointUrl("sqliteReadOnly");
      const sealedUrl = new URL("file:///worker-bundle/github-exec-launcher.mjs");
      registerSealedRuntimeProcessEntrypoint("githubExec", sealedUrl);
      expect(resolveRuntimeProcessEntrypointUrl("githubExec")).toEqual(sealedUrl);
      expect(resolveRuntimeProcessEntrypointUrl("sqliteReadOnly")).toEqual(sqliteUrl);
    } finally {
      vi.resetModules();
    }
  });
});
