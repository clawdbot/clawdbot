// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "..");

function productionTypeScriptFiles(dir = sourceRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return productionTypeScriptFiles(filePath);
    }
    if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) {
      return [];
    }
    return [filePath];
  });
}

function matchingFiles(pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const filePath of productionTypeScriptFiles()) {
    if (pattern.test(readFileSync(filePath, "utf8"))) {
      matches.push(path.relative(sourceRoot, filePath));
    }
  }
  return matches.toSorted();
}

describe("Web Awesome control ownership", () => {
  it("keeps dialogs, menus, and tabs on shared primitives", () => {
    expect(matchingFiles(/<dialog\b/u)).toEqual([]);
    expect(
      matchingFiles(/<[a-z][^>]*\srole=["'](?:menu|menubar|menuitem|tab|tablist)["']/u),
    ).toEqual([]);
    expect(
      matchingFiles(/<details\b[^>]*class=["'][^"']*(?:menu|select|popover|dropdown)/u),
    ).toEqual([
      "pages/chat/components/chat-effort-picker.ts",
      "pages/chat/components/chat-model-picker.ts",
    ]);
  });

  it("limits custom comboboxes to approved searchable controls", () => {
    // Web Awesome Core has no combobox; its combobox is a paid Pro component.
    // This inventory tracks literal ARIA roles, not Web Awesome elements that own roles internally.
    expect(matchingFiles(/<[a-z][^>]*\srole=["'](?:combobox|listbox|option)["']/u)).toEqual([
      "components/command-palette.ts",
      "components/composer-menu.ts",
      "components/multi-select.ts",
      "components/select-picker.ts",
      "pages/chat/components/chat-model-picker-options.ts",
      "pages/chat/components/chat-model-picker.ts",
      "pages/new-session/place-browser.ts",
    ]);
  });

  it("limits custom dividers to docked multi-pane layouts", () => {
    // Web Awesome split panel owns exactly two panes; these layouts coordinate
    // sidebar, inspector, and responsive dock state across more than two panes.
    expect(matchingFiles(/<resizable-divider\b/u)).toEqual([
      "app/app-shell-view.ts",
      "components/dock-layout-controller.ts",
      "pages/chat/chat-page.ts",
      "pages/chat/components/chat-resizable-divider.ts",
      "pages/skill-workshop/view.ts",
    ]);
  });
});
