// @vitest-environment node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "..");

async function productionTypeScriptFiles(dir = sourceRoot): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return productionTypeScriptFiles(filePath);
      }
      if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) {
        return [];
      }
      return [filePath];
    }),
  );
  return files.flat();
}

async function matchingFiles(pattern: RegExp): Promise<string[]> {
  const matches: string[] = [];
  for (const filePath of await productionTypeScriptFiles()) {
    if (pattern.test(await readFile(filePath, "utf8"))) {
      matches.push(path.relative(sourceRoot, filePath));
    }
  }
  return matches.toSorted();
}

describe("Web Awesome control ownership", () => {
  it("keeps dialogs, menus, and tabs on shared primitives", async () => {
    expect(await matchingFiles(/<dialog\b/u)).toEqual([]);
    expect(
      await matchingFiles(/<[a-z][^>]*\srole=["'](?:menu|menubar|menuitem|tab|tablist)["']/u),
    ).toEqual([]);
    expect(
      await matchingFiles(/<details\b[^>]*class=["'][^"']*(?:menu|select|popover|dropdown)/u),
    ).toEqual(["pages/chat/components/chat-model-controls.ts"]);
  });

  it("limits custom comboboxes to dynamic suggestion surfaces", async () => {
    // Web Awesome Core has no combobox; its combobox is a paid Pro component.
    expect(await matchingFiles(/<[a-z][^>]*\srole=["'](?:combobox|listbox|option)["']/u)).toEqual([
      "components/command-palette.ts",
      "pages/chat/components/chat-composer.ts",
      "pages/chat/components/chat-model-controls.ts",
    ]);
  });

  it("limits custom dividers to docked multi-pane layouts", async () => {
    // Web Awesome split panel owns exactly two panes; these layouts coordinate
    // sidebar, inspector, and responsive dock state across more than two panes.
    expect(await matchingFiles(/<resizable-divider\b/u)).toEqual([
      "app/app-host.ts",
      "pages/chat/chat-page.ts",
      "pages/chat/chat-view.ts",
    ]);
  });
});
