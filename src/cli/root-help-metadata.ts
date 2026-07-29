// Cached startup metadata readers for precomputed root and subcommand help text.
import { readCliStartupMetadata } from "./startup-metadata.js";

export type PrecomputedSubcommandHelpName =
  | "doctor"
  | "gateway"
  | "models"
  | "plugins"
  | "sessions"
  | "tasks";

let precomputedRootHelpText: string | null | undefined;
let precomputedBrowserHelpText: string | null | undefined;
let precomputedSecretsHelpText: string | null | undefined;
let precomputedNodesHelpText: string | null | undefined;
let precomputedSubcommandHelpText:
  | Partial<Record<PrecomputedSubcommandHelpName, string | null>>
  | undefined;

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
  // Missing metadata is expected in source checkouts; fall back to live Commander help.
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

function loadPrecomputedSubcommandHelpText(commandName: string): string | null {
  if (!isPrecomputedSubcommandHelpName(commandName)) {
    return null;
  }
  const cache = precomputedSubcommandHelpText?.[commandName];
  if (cache !== undefined) {
    return cache;
  }
  try {
    const parsed = readCliStartupMetadata(import.meta.url);
    const subcommandHelpText = parsed?.subcommandHelpText;
    if (isSubcommandHelpTextRecord(subcommandHelpText)) {
      const value = subcommandHelpText[commandName];
      if (typeof value === "string" && value.length > 0) {
        setPrecomputedSubcommandHelpText(commandName, value);
        return value;
      }
    }
  } catch {
    // Fall back to live help rendering.
  }
  setPrecomputedSubcommandHelpText(commandName, null);
  return null;
}

export function outputPrecomputedRootHelpText(): boolean {
  const rootHelpText = loadPrecomputedHelpText("rootHelpText", precomputedRootHelpText, (value) => {
    precomputedRootHelpText = value;
  });
  if (!rootHelpText) {
    return false;
  }
  process.stdout.write(rootHelpText);
  return true;
}

export function outputPrecomputedBrowserHelpText(): boolean {
  const browserHelpText = loadPrecomputedHelpText(
    "browserHelpText",
    precomputedBrowserHelpText,
    (value) => {
      precomputedBrowserHelpText = value;
    },
  );
  if (!browserHelpText) {
    return false;
  }
  process.stdout.write(browserHelpText);
  return true;
}

export function outputPrecomputedSecretsHelpText(): boolean {
  const secretsHelpText = loadPrecomputedHelpText(
    "secretsHelpText",
    precomputedSecretsHelpText,
    (value) => {
      precomputedSecretsHelpText = value;
    },
  );
  if (!secretsHelpText) {
    return false;
  }
  process.stdout.write(secretsHelpText);
  return true;
}

export function outputPrecomputedNodesHelpText(): boolean {
  const nodesHelpText = loadPrecomputedHelpText(
    "nodesHelpText",
    precomputedNodesHelpText,
    (value) => {
      precomputedNodesHelpText = value;
    },
  );
  if (!nodesHelpText) {
    return false;
  }
  process.stdout.write(nodesHelpText);
  return true;
}

export function outputPrecomputedSubcommandHelpText(commandName: string): boolean {
  const helpText = loadPrecomputedSubcommandHelpText(commandName);
  if (!helpText) {
    return false;
  }
  process.stdout.write(helpText);
  return true;
}

function isPrecomputedSubcommandHelpName(
  commandName: string,
): commandName is PrecomputedSubcommandHelpName {
  return (
    commandName === "doctor" ||
    commandName === "gateway" ||
    commandName === "models" ||
    commandName === "plugins" ||
    commandName === "sessions" ||
    commandName === "tasks"
  );
}

function isSubcommandHelpTextRecord(
  value: unknown,
): value is Partial<Record<PrecomputedSubcommandHelpName, unknown>> {
  return typeof value === "object" && value !== null;
}

function setPrecomputedSubcommandHelpText(
  commandName: PrecomputedSubcommandHelpName,
  value: string | null,
): void {
  precomputedSubcommandHelpText = {
    ...precomputedSubcommandHelpText,
    [commandName]: value,
  };
}
