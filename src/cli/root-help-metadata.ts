import { readCliStartupMetadata } from "./startup-metadata.js";

let precomputedRootHelpText: string | null | undefined;
let precomputedBrowserHelpText: string | null | undefined;
let precomputedSecretsHelpText: string | null | undefined;
let precomputedNodesHelpText: string | null | undefined;

type PrecomputedHelpTextKey =
  | "rootHelpText"
  | "browserHelpText"
  | "secretsHelpText"
  | "nodesHelpText";

function loadPrecomputedHelpText(
  key: PrecomputedHelpTextKey,
  cache: string | null | undefined,
  setCache: (value: string | null) => void,
): string | null {
  if (cache !== undefined) {
    return cache;
  }
  try {
    const parsed = readCliStartupMetadata(import.meta.url);
    if (parsed) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) {
        setCache(value);
        return value;
      }
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

export function loadPrecomputedSecretsHelpText(): string | null {
  return loadPrecomputedHelpText("secretsHelpText", precomputedSecretsHelpText, (value) => {
    precomputedSecretsHelpText = value;
  });
}

export function loadPrecomputedNodesHelpText(): string | null {
  return loadPrecomputedHelpText("nodesHelpText", precomputedNodesHelpText, (value) => {
    precomputedNodesHelpText = value;
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

export function outputPrecomputedSecretsHelpText(): boolean {
  const secretsHelpText = loadPrecomputedSecretsHelpText();
  if (!secretsHelpText) {
    return false;
  }
  process.stdout.write(secretsHelpText);
  return true;
}

export function outputPrecomputedNodesHelpText(): boolean {
  const nodesHelpText = loadPrecomputedNodesHelpText();
  if (!nodesHelpText) {
    return false;
  }
  process.stdout.write(nodesHelpText);
  return true;
}

export const testing = {
  resetPrecomputedRootHelpTextForTests(): void {
    precomputedRootHelpText = undefined;
    precomputedBrowserHelpText = undefined;
    precomputedSecretsHelpText = undefined;
    precomputedNodesHelpText = undefined;
  },
};
export { testing as __testing };
