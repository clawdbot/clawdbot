// Resource loader tests cover compatibility wiring for SDK prompt transform
// aliases.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "./resource-loader.js";

describe("DefaultResourceLoader", () => {
  it("keeps deprecated SDK prompt override aliases wired to prompt transforms", async () => {
    // These aliases are deprecated but shipped SDK surface, so they still map
    // through the same transform path as the current options.
    const root = mkdtempSync(join(tmpdir(), "openclaw-resource-loader-"));
    try {
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
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
