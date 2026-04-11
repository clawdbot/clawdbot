import { isGatewayConfigBypassCommandPath } from "../gateway/explicit-connection-policy.js";
import { cliCommandCatalog, type CliCommandPathPolicy } from "./command-catalog.js";
import { matchesCommandPath } from "./command-path-matches.js";

const DEFAULT_CLI_COMMAND_PATH_POLICY: CliCommandPathPolicy = {
  bypassConfigGuard: false,
  routeConfigGuard: "never",
  loadPlugins: "never",
  hideBanner: false,
  ensureCliPath: true,
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
