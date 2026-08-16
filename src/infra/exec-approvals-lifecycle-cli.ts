// Classifies direct OpenClaw service-lifecycle commands and shared positional option layouts.
import { classifyOpenClawGatewayArgv } from "./exec-approvals-lifecycle-gateway.js";
import { classifyOpenClawNodeServiceArgv } from "./exec-approvals-lifecycle-node-service.js";
import {
  lifecycleHasEffectiveBooleanOption,
  lifecycleOptionName as optionName,
} from "./exec-approvals-lifecycle-tokens.js";

const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const OPENCLAW_GLOBAL_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_OPTIONS = new Set(["--container", "--log-level", "--profile"]);
const DRY_RUN_OPTION = new Set(["--dry-run"]);

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("`", "").replaceAll("^", "");
}

export function lifecycleHasHelpOrVersion(
  argv: readonly string[],
  extraFlags?: ReadonlySet<string>,
): boolean {
  for (const token of argv) {
    if (token === "--") {
      return false;
    }
    if (HELP_OR_VERSION_FLAGS.has(token.trim()) || extraFlags?.has(normalizedToken(token))) {
      return true;
    }
  }
  return false;
}

export function lifecycleHasEffectiveHelpOrVersion(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
): boolean {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      break;
    }
    const name = optionName(token);
    if (HELP_OR_VERSION_FLAGS.has(token)) {
      return true;
    }
    if (optionsWithValue.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return false;
}

export function lifecycleFirstPositional(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
): number {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
    const name = optionName(token);
    if (optionsWithValue.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return argv.length;
}

/** Return true when direct OpenClaw argv performs a lifecycle mutation. */
export function classifyOpenClawArgv(argv: readonly string[]): boolean {
  let index = 1;
  for (; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const lower = normalizedToken(token);
    if (HELP_OR_VERSION_FLAGS.has(token)) {
      return false;
    }
    if (OPENCLAW_GLOBAL_FLAGS.has(lower)) {
      continue;
    }
    const name = optionName(token);
    if (OPENCLAW_GLOBAL_OPTIONS.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    break;
  }

  const command = normalizedToken(argv[index]);
  switch (command) {
    case "daemon":
    case "gateway":
      return classifyOpenClawGatewayArgv(argv, index + 1);
    case "uninstall":
      return (
        !lifecycleHasHelpOrVersion(argv.slice(index + 1)) &&
        !lifecycleHasEffectiveBooleanOption(argv, index + 1, DRY_RUN_OPTION)
      );
    case "node":
      return classifyOpenClawNodeServiceArgv(argv, index + 1);
    default:
      return false;
  }
}
