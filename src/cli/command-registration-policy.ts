// Decides which built-in and plugin commands need registration for one CLI invocation.
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";

const RESERVED_NON_PLUGIN_COMMAND_ROOTS = new Set(["tool", "tools"]);
const PLUGIN_YIELDING_BUILTIN_COMMAND_ROOTS = new Set(["auth"]);

export function isReservedNonPluginCommandRoot(primary: string | null | undefined): boolean {
  return typeof primary === "string" && RESERVED_NON_PLUGIN_COMMAND_ROOTS.has(primary);
}

export function isPluginYieldingBuiltinCommandRoot(primary: string | null | undefined): boolean {
  return typeof primary === "string" && PLUGIN_YIELDING_BUILTIN_COMMAND_ROOTS.has(primary);
}

export function shouldRegisterPrimaryCommandOnly(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return invocation.primary !== null || !invocation.hasHelpOrVersion;
}

export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  // Help/version invocations can skip plugin registration when built-ins can answer directly.
  const invocation = resolveCliArgvInvocation(params.argv);
  if (params.primary === "help") {
    return invocation.hasHelpOrVersion && invocation.commandPath.length <= 1;
  }
  if (invocation.hasHelpOrVersion) {
    return (
      !params.primary || params.hasBuiltinPrimary || isReservedNonPluginCommandRoot(params.primary)
    );
  }
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return invocation.hasHelpOrVersion;
  }
  if (isReservedNonPluginCommandRoot(params.primary)) {
    return true;
  }
  return false;
}

export function shouldEagerRegisterSubcommands(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS);
}

export function shouldRegisterPrimarySubcommandOnly(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !shouldEagerRegisterSubcommands(env) && shouldRegisterPrimaryCommandOnly(argv);
}
