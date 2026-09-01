// Cached startup metadata readers for precomputed root and subcommand help text.
import { readCliStartupMetadata } from "./startup-metadata.js";

export type PrecomputedSubcommandHelpName =
  | "config"
  | "doctor"
  | "gateway"
  | "models"
  | "plugins"
  | "sessions"
  | "tasks";

type PrecomputedHelpTextKey =
  | "rootHelpText"
  | "browserHelpText"
  | "secretsHelpText"
  | "nodesHelpText"
  | PrecomputedSubcommandHelpName;

const precomputedHelpText = new Map<PrecomputedHelpTextKey, string | null>();

function loadPrecomputedHelpText(key: PrecomputedHelpTextKey): string | null {
  const cached = precomputedHelpText.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let helpText: string | null = null;
  try {
    const parsed = readCliStartupMetadata(import.meta.url);
    let value: unknown;
    if (isPrecomputedSubcommandHelpName(key)) {
      const subcommandHelpText = parsed?.subcommandHelpText;
      if (isSubcommandHelpTextRecord(subcommandHelpText)) {
        value = subcommandHelpText[key];
      }
    } else if (parsed) {
      value = parsed[key];
    }
    if (typeof value === "string" && value.length > 0) {
      helpText = value;
    }
  } catch {
    // Missing metadata is expected in source checkouts; fall back to live Commander help.
  }
  // Entry can retry command help through run-main; keep a miss even if the
  // metadata reader advances from a falsy direct record to the parent layout.
  precomputedHelpText.set(key, helpText);
  return helpText;
}

function outputPrecomputedHelpText(key: PrecomputedHelpTextKey): boolean {
  const helpText = loadPrecomputedHelpText(key);
  if (!helpText) {
    return false;
  }
  process.stdout.write(helpText);
  return true;
}

export function outputPrecomputedRootHelpText(): boolean {
  return outputPrecomputedHelpText("rootHelpText");
}

export function outputPrecomputedBrowserHelpText(): boolean {
  return outputPrecomputedHelpText("browserHelpText");
}

export function outputPrecomputedSecretsHelpText(): boolean {
  return outputPrecomputedHelpText("secretsHelpText");
}

export function outputPrecomputedNodesHelpText(): boolean {
  return outputPrecomputedHelpText("nodesHelpText");
}

export function outputPrecomputedSubcommandHelpText(commandName: string): boolean {
  return isPrecomputedSubcommandHelpName(commandName) && outputPrecomputedHelpText(commandName);
}

function isPrecomputedSubcommandHelpName(
  commandName: string,
): commandName is PrecomputedSubcommandHelpName {
  return (
    commandName === "config" ||
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
