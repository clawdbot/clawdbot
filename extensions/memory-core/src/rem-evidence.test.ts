import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewGroundedRemMarkdown } from "./rem-evidence.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const harness = createMemoryCoreTestHarness();

describe("grounded REM evidence", () => {
  it("retains every reflection source while bounding displayed citations", async () => {
    const workspaceDir = await harness.createTempWorkspace("rem-reflection-origins-");
    const inputPath = path.join(workspaceDir, "memory", "2026-02-01.md");
    await fs.mkdir(path.dirname(inputPath));
    await fs.writeFile(
      inputPath,
      ["Alice", "Bob", "Carol", "Drew"]
        .map((person) => `## ${person}\n${person} lives in a quiet seaside town.\n`)
        .join("\n"),
    );
    const preview = await previewGroundedRemMarkdown({ workspaceDir, inputPaths: [inputPath] });
    const file = preview.files[0]!;
    const reflection = file.reflections.find(({ text }) =>
      text.includes("More than one active relationship"),
    );
    expect(reflection).toBeDefined();
    expect(reflection!.refs).toEqual([
      "memory/2026-02-01.md:2",
      "memory/2026-02-01.md:5",
      "memory/2026-02-01.md:8",
      "memory/2026-02-01.md:11",
    ]);
    const rendered = file.renderedMarkdown
      .split("\n")
      .find((line) => line.includes(reflection!.text));
    expect(rendered).toContain("memory/2026-02-01.md:8");
    expect(rendered).not.toContain("memory/2026-02-01.md:11");
  });
});
