import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function copyPrWrapperSources(destination: string): string[] {
  // Keep fixture sources and commits on the production inventory. Extracted
  // execution tests catch missing dependencies without a second source list.
  const inventory = readFileSync("scripts/pr", "utf8").match(
    /pr_wrapper_components=\(\n([\s\S]*?)\n\)/,
  )?.[1];
  if (!inventory) {
    throw new Error("Missing scripts/pr wrapper component inventory");
  }
  const components = inventory
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const component of components) {
    mkdirSync(dirname(join(destination, component)), { recursive: true });
    cpSync(component, join(destination, component), { recursive: true });
  }
  return components;
}
