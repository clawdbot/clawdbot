// Classifies direct OpenClaw CLI commands and shared positional option layouts.
import { classifyOpenClawConfigArgv } from "./exec-approvals-lifecycle-config.js";
import { classifyOpenClawDoctorArgv } from "./exec-approvals-lifecycle-doctor.js";
import { classifyOpenClawGatewayArgv } from "./exec-approvals-lifecycle-gateway.js";
import { classifyOpenClawNodeServiceArgv } from "./exec-approvals-lifecycle-node-service.js";
import {
  classifyOpenClawHooksArgv,
  classifyOpenClawPluginsArgv,
} from "./exec-approvals-lifecycle-plugins.js";
import { classifyOpenClawApprovalPolicyArgv } from "./exec-approvals-lifecycle-policy.js";
import { classifyOpenClawResetArgv } from "./exec-approvals-lifecycle-reset.js";
import {
  lifecycleHasEffectiveBooleanOption,
  lifecycleOptionName as optionName,
} from "./exec-approvals-lifecycle-tokens.js";

const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const OPENCLAW_GLOBAL_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_OPTIONS = new Set(["--container", "--log-level", "--profile"]);
const UPDATE_OPTIONS_WITH_VALUE = new Set(["--channel", "--tag", "--timeout"]);
const SETUP_OPTIONS_WITH_VALUE = new Set([
  "--auth-choice",
  "--cloudflare-ai-gateway-account-id",
  "--cloudflare-ai-gateway-gateway-id",
  "--custom-api-key",
  "--custom-base-url",
  "--custom-compatibility",
  "--custom-model-id",
  "--custom-provider-id",
  "--daemon-runtime",
  "--flow",
  "--gateway-auth",
  "--gateway-bind",
  "--gateway-password",
  "--gateway-port",
  "--gateway-token",
  "--gateway-token-ref-env",
  "--import-from",
  "--import-source",
  "--message",
  "--mode",
  "--node-manager",
  "--remote-token",
  "--remote-url",
  "--reset-scope",
  "--secret-input-mode",
  "--section",
  "--tailscale",
  "--token",
  "--token-expires-in",
  "--token-profile-id",
  "--token-provider",
  "--workspace",
]);
const DRY_RUN_OPTION = new Set(["--dry-run"]);

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("`", "").replaceAll("^", "");
}

export function lifecycleHasHelpOrVersion(argv: readonly string[]): boolean {
  return argv.some((token) => HELP_OR_VERSION_FLAGS.has(token.trim()));
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

function classifyUpdateArgv(argv: readonly string[], start: number): boolean {
  if (lifecycleHasEffectiveHelpOrVersion(argv, start, UPDATE_OPTIONS_WITH_VALUE)) {
    return false;
  }
  const positionalIndex = lifecycleFirstPositional(argv, start, UPDATE_OPTIONS_WITH_VALUE);
  const action = normalizedToken(argv[positionalIndex]);
  if (action === "status") {
    return false;
  }
  if (
    lifecycleHasEffectiveBooleanOption(argv, start, DRY_RUN_OPTION, UPDATE_OPTIONS_WITH_VALUE) &&
    !["finalize", "repair", "wizard"].includes(action)
  ) {
    return false;
  }
  return true;
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
    if (lower === "--update") {
      return classifyUpdateArgv(argv, index + 1);
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
    case "approvals":
    case "exec-approvals":
    case "exec-policy":
      return classifyOpenClawApprovalPolicyArgv(command, argv, index + 1);
    case "config":
      return classifyOpenClawConfigArgv(argv, index + 1);
    case "daemon":
    case "gateway":
      return classifyOpenClawGatewayArgv(argv, index + 1);
    case "uninstall":
      return (
        !lifecycleHasHelpOrVersion(argv.slice(index + 1)) &&
        !lifecycleHasEffectiveBooleanOption(argv, index + 1, DRY_RUN_OPTION)
      );
    case "update":
      return classifyUpdateArgv(argv, index + 1);
    case "doctor":
      return classifyOpenClawDoctorArgv(argv, index + 1);
    case "node":
      return classifyOpenClawNodeServiceArgv(argv, index + 1);
    case "hooks":
      return classifyOpenClawHooksArgv(argv, index + 1);
    case "plugins":
      return classifyOpenClawPluginsArgv(argv, index + 1);
    case "reset":
      return classifyOpenClawResetArgv(argv, index + 1);
    case "configure":
    case "onboard":
    case "setup":
      return !lifecycleHasEffectiveHelpOrVersion(argv, index + 1, SETUP_OPTIONS_WITH_VALUE);
    default:
      return false;
  }
}
