import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMediaToolLocalRoots, resolveModelFromRegistry } from "./media-tool-shared.js";

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

describe("resolveMediaToolLocalRoots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not widen default local roots from media sources", () => {
    const stateDir = path.join("/tmp", "openclaw-media-tool-roots-state");
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";
    const moviesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Movies" : "/Users/peter/Movies";

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = resolveMediaToolLocalRoots(path.join(stateDir, "workspace-agent"), undefined, [
      path.join(picturesDir, "photo.png"),
      pathToFileURL(path.join(moviesDir, "clip.mp4")).href,
      "/top-level-file.png",
    ]);

    const normalizedRoots = roots.map(normalizeHostPath);
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-agent")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(picturesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath(moviesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath("/"));
  });
});

describe("resolveModelFromRegistry", () => {
  it("normalizes provider and model refs before registry lookup", () => {
    const foundModel = { provider: "ollama", id: "qwen3.5:397b-cloud" };
    const find = vi.fn(() => foundModel);

    const result = resolveModelFromRegistry({
      modelRegistry: { find },
      provider: " OLLAMA ",
      modelId: " qwen3.5:397b-cloud ",
    });

    expect(find).toHaveBeenCalledWith("ollama", "qwen3.5:397b-cloud");
    expect(result).toBe(foundModel);
  });

  it("reports the normalized ref when the registry lookup misses", () => {
    const find = vi.fn(() => null);

    expect(() =>
      resolveModelFromRegistry({
        modelRegistry: { find },
        provider: " OLLAMA ",
        modelId: " qwen3.5:397b-cloud ",
      }),
    ).toThrow("Unknown model: ollama/qwen3.5:397b-cloud");
  });

  it("falls back to provider-prefixed custom model IDs", () => {
    const foundModel = { provider: "kimchi", id: "kimchi/claude-opus-4-6" };
    const find = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(foundModel);

    const result = resolveModelFromRegistry({
      modelRegistry: { find },
      provider: "kimchi",
      modelId: "claude-opus-4-6",
    });

    expect(find.mock.calls).toEqual([
      ["kimchi", "claude-opus-4-6"],
      ["kimchi", "kimchi/claude-opus-4-6"],
    ]);
    expect(result).toBe(foundModel);
  });
});
