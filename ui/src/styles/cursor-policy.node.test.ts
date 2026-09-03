// Control UI tests cover the cursor policy's source-level shape.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));

function collectStyleSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : collectStyleSources(entryPath);
    }
    if (!entry.isFile() || entry.name.includes(".test.")) {
      return [];
    }
    return entry.name.endsWith(".css") || entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

/** Walks back from a declaration line to the selector list that owns it. */
function selectorFor(lines: readonly string[], declarationIndex: number): string {
  const parts: string[] = [];
  for (let index = declarationIndex - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.endsWith("{")) {
      parts.unshift(line.slice(0, -1).trim());
      for (let above = index - 1; above >= 0 && lines[above]?.trim().endsWith(","); above -= 1) {
        parts.unshift(lines[above]!.trim());
      }
      break;
    }
    if (line === "" || line.endsWith("}")) {
      break;
    }
  }
  return parts.join(" ");
}

function selectorBranches(selector: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === "(" || character === "[") {
      depth += 1;
    } else if (character === ")" || character === "]") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      branches.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  branches.push(selector.slice(start).trim());
  return branches;
}

const ANCHOR_SELECTOR = /(^|[\s,(>~+])a([.#:[]|\b)/u;
const NEW_TAB_ACTION_SELECTOR = /\[data-new-tab-action\]/u;

describe("Control UI cursor policy", () => {
  it("keeps the unconditional pointer on links and explicit new-tab controls only", () => {
    const offenders = collectStyleSources(path.join(stylesDir, ".."))
      .flatMap((filePath) => {
        const lines = fs.readFileSync(filePath, "utf8").split("\n");
        return lines.flatMap((line, index) =>
          /^\s*cursor:\s*pointer;\s*$/u.test(line)
            ? selectorBranches(selectorFor(lines, index)).map((selector) => ({
                file: path.relative(stylesDir, filePath),
                selector,
              }))
            : [],
        );
      })
      .filter(
        (hit) => !ANCHOR_SELECTOR.test(hit.selector) && !NEW_TAB_ACTION_SELECTOR.test(hit.selector),
      );

    // State controls consume var(--cursor-action); only links and the explicit
    // browser-tab/window hook may own an unconditional hand.
    expect(offenders).toEqual([]);
  });
});
