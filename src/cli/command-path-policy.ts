import { isGatewayConfigBypassCommandPath } from "../gateway/explicit-connection-policy.js";
import { getCommandPathWithRootOptions } from "./argv.js";
import {
  cliCommandCatalog,
  type CliCommandPathPolicy,
  type CliNetworkProxyPolicy,
} from "./command-catalog.js";
import { matchesCommandPath } from "./command-path-matches.js";
import { resolveGatewayCatalogCommandPath } from "./gateway-run-argv.js";

const DEFAULT_CLI_COMMAND_PATH_POLICY: CliCommandPathPolicy = {
  bypassConfigGuard: false,
  routeConfigGuard: "never",
  loadPlugins: "never",
  pluginRegistry: { scope: "all" },
  hideBanner: false,
  ensureCliPath: true,
  networkProxy: "default",
};

export function resolveCliCommandPathPolicy(commandPath: string[]): CliCommandPathPolicy {
  let resolvedPolicy: CliCommandPathPolicy = { ...DEFAULT_CLI_COMMAND_PATH_POLICY };
  for (const entry of cliCommandCatalog) {
    if (!entry.policy) {
      continue;
    }
    if (!matchesCommandPath(commandPath, entry.commandPath, { exact: entry.exact })) {
      continue;
    }
    Object.assign(resolvedPolicy, entry.policy);
  }
  if (isGatewayConfigBypassCommandPath(commandPath)) {
    resolvedPolicy.bypassConfigGuard = true;
  }
  return resolvedPolicy;
}

function isCommandPathPrefix(commandPath: string[], pattern: readonly string[]): boolean {
  return pattern.every((segment, index) => commandPath[index] === segment);
}

export function resolveCliCatalogCommandPath(argv: string[]): string[] {
  const tokens =
    resolveGatewayCatalogCommandPath(argv) ?? getCommandPathWithRootOptions(argv, argv.length);
  if (tokens.length === 0) {
    return [];
  }
  let bestMatch: readonly string[] | null = null;
  for (const entry of cliCommandCatalog) {
    if (!isCommandPathPrefix(tokens, entry.commandPath)) {
      continue;
    }
    if (!bestMatch || entry.commandPath.length > bestMatch.length) {
      bestMatch = entry.commandPath;
    }
  }
  return bestMatch ? [...bestMatch] : [tokens[0]];
}

export function resolveCliNetworkProxyPolicy(argv: string[]): CliNetworkProxyPolicy {
  const commandPath = resolveCliCatalogCommandPath(argv);
  const networkProxy = resolveCliCommandPathPolicy(commandPath).networkProxy;
  return typeof networkProxy === "function" ? networkProxy({ argv, commandPath }) : networkProxy;
}
