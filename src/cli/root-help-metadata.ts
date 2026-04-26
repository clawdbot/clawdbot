import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let precomputedRootHelpText: string | null | undefined;
let precomputedBrowserHelpText: string | null | undefined;

function loadPrecomputedHelpText(
  key: "rootHelpText" | "browserHelpText",
  cache: string | null | undefined,
  setCache: (value: string | null) => void,
): string | null {
  if (cache !== undefined) {
    return cache;
  }
  try {
    const metadataPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "cli-startup-metadata.json",
    );
    const raw = fs.readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[key];
    if (typeof value === "string" && value.length > 0) {
      setCache(value);
      return value;
    }
  } catch {
    // Fall back to live help rendering.
  }
  setCache(null);
  return null;
}

export function loadPrecomputedRootHelpText(): string | null {
  return loadPrecomputedHelpText("rootHelpText", precomputedRootHelpText, (value) => {
    precomputedRootHelpText = value;
  });
}

export function loadPrecomputedBrowserHelpText(): string | null {
  return loadPrecomputedHelpText("browserHelpText", precomputedBrowserHelpText, (value) => {
    precomputedBrowserHelpText = value;
  });
}

export function outputPrecomputedRootHelpText(): boolean {
  const rootHelpText = loadPrecomputedRootHelpText();
  if (!rootHelpText) {
    return false;
  }
  process.stdout.write(rootHelpText);
  return true;
}

export function outputPrecomputedBrowserHelpText(): boolean {
  const browserHelpText = loadPrecomputedBrowserHelpText();
  if (!browserHelpText) {
    return false;
  }
  process.stdout.write(browserHelpText);
  return true;
}

export const __testing = {
  resetPrecomputedRootHelpTextForTests(): void {
    precomputedRootHelpText = undefined;
    precomputedBrowserHelpText = undefined;
  },
};
