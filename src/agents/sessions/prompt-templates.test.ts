// Prompt template tests cover markdown discovery and fallback metadata.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadPromptTemplates } from "./prompt-templates.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("loadPromptTemplates", () => {
  it("keeps fallback descriptions on a UTF-16 boundary", async () => {
    const root = tempDirs.make("openclaw-prompt-templates-");
    const promptsDir = join(root, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, "emoji.md"), `${"a".repeat(59)}🚀tail\n`, "utf-8");

    const templates = loadPromptTemplates({
      cwd: root,
      agentDir: join(root, "agent"),
      promptPaths: [promptsDir],
      includeDefaults: false,
    });

    expect(templates).toHaveLength(1);
    expect(templates[0]?.description).toBe(`${"a".repeat(59)}...`);
  });

  it("preserves dash-prefixed Markdown as prompt content", async () => {
    const root = tempDirs.make("openclaw-prompt-templates-");
    const promptsDir = join(root, "prompts");
    await mkdir(promptsDir, { recursive: true });
    const content = "----\nname: bogus\ndescription: must remain Markdown\n---\n# Body\n";
    await writeFile(join(promptsDir, "dash-prefix.md"), content, "utf-8");

    const templates = loadPromptTemplates({
      cwd: root,
      agentDir: join(root, "agent"),
      promptPaths: [promptsDir],
      includeDefaults: false,
    });

    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      name: "dash-prefix",
      description: "----",
      content,
    });
  });
});
