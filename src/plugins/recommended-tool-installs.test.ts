import { describe, expect, it } from "vitest";
import { listRecommendedToolInstalls } from "./recommended-tool-installs.js";

describe("recommended tool installs", () => {
  it("loads the complete bundled catalog with unique HTTPS metadata", () => {
    const installs = listRecommendedToolInstalls();

    expect(installs.map((entry) => entry.id)).toEqual([
      "ollama",
      "lmstudio",
      "claude-code",
      "codex-cli",
      "pi",
      "opencode",
      "gemini-cli",
      "kimi-code",
      "grok-build",
    ]);
    expect(new Set(installs.map((entry) => entry.id)).size).toBe(installs.length);
    for (const entry of installs) {
      expect(entry.label).not.toBe("");
      expect(entry.hint).not.toBe("");
      expect(entry.website.startsWith("https://")).toBe(true);
      expect(entry.icon.startsWith("https://")).toBe(true);
      expect(entry.website.length).toBeLessThanOrEqual(2048);
      expect(entry.icon.length).toBeLessThanOrEqual(2048);
      expect(new URL(entry.website).protocol).toBe("https:");
      expect(new URL(entry.icon).protocol).toBe("https:");
    }
  });
});
