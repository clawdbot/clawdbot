// Resource loader tests cover compatibility wiring for SDK prompt transform
// aliases.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DefaultResourceLoader } from "./resource-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("DefaultResourceLoader", () => {
  it("does not use unreadable prompt file paths as prompt content", async () => {
    const root = tempDirs.make("openclaw-resource-loader-");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: root,
        appendSystemPrompt: [root],
      });

      await loader.reload();

      expect(loader.getSystemPrompt()).toBeUndefined();
      expect(loader.getAppendSystemPrompt()).toEqual([]);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps deprecated SDK prompt override aliases wired to prompt transforms", async () => {
    // These aliases are deprecated but shipped SDK surface, so they still map
    // through the same transform path as the current options.
    const root = tempDirs.make("openclaw-resource-loader-");
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "base",
      appendSystemPrompt: ["tail"],
      systemPromptOverride: (base) => `${base ?? ""} legacy`,
      appendSystemPromptOverride: (base) => [...base, "legacy"],
    });

    await loader.reload();

    expect(loader.getSystemPrompt()).toBe("base legacy");
    expect(loader.getAppendSystemPrompt()).toEqual(["tail", "legacy"]);
  });
});
