/**
 * Classifies `<server>__*` deny entries that a plugin harness can enforce by
 * omitting the configured MCP server from its native projection.
 */
import { normalizeConfiguredMcpServers } from "../../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assignSafeServerNames, TOOL_NAME_SEPARATOR } from "../agent-bundle-mcp-names.js";
import { partitionMcpServersByConnectionScope } from "../mcp-connection-resolver.js";
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";

/** Normalized `<server>__*` deny pattern → configured `mcp.servers` key. */
export type HarnessDeniableMcpServerPatterns = ReadonlyMap<string, string>;

/**
 * Maps every whole-server deny pattern to the static configured server it names.
 * Both the raw config key and its sanitized model-facing prefix are accepted, so
 * `mcp.servers["Gamma Mail"]` matches `gamma-mail__*` as well. A pattern that
 * could name more than one server (one server's raw key normalizing to another
 * server's safe name) is omitted, so such a deny stays fail-closed instead of
 * disabling the wrong server. Requester-scoped servers never enter
 * harness-native config and are omitted.
 */
export function resolveHarnessDeniableMcpServerPatterns(
  config: OpenClawConfig | undefined,
): HarnessDeniableMcpServerPatterns {
  const configured = normalizeConfiguredMcpServers(config?.mcp?.servers);
  const { staticServers } = partitionMcpServersByConnectionScope(configured);
  // Safe names are assigned over the full declared set so collision suffixes
  // match the names the projection actually exposes.
  const safeNames = assignSafeServerNames(Object.keys(configured));
  const candidates = new Map<string, Set<string>>();
  for (const serverName of Object.keys(configured)) {
    for (const prefix of [serverName, safeNames.get(serverName) ?? serverName]) {
      // A key holding glob syntax would make `<key>__*` match other servers'
      // tools under ordinary policy matching; leave such denies fail-closed.
      if (/[*?]/.test(prefix)) {
        continue;
      }
      const pattern = normalizeToolPolicyName(`${prefix}${TOOL_NAME_SEPARATOR}*`);
      const owners = candidates.get(pattern) ?? new Set<string>();
      owners.add(serverName);
      candidates.set(pattern, owners);
    }
  }
  const patterns = new Map<string, string>();
  for (const [pattern, owners] of candidates) {
    if (owners.size !== 1) {
      continue;
    }
    const [serverName] = owners;
    if (serverName !== undefined && Object.hasOwn(staticServers, serverName)) {
      patterns.set(pattern, serverName);
    }
  }
  return patterns;
}

/** Sorted configured server names denied as a whole by any of the given policies. */
export function collectHarnessDeniedMcpServers(
  policies: ReadonlyArray<{ allow?: string[]; deny?: string[] } | undefined>,
  patterns: HarnessDeniableMcpServerPatterns | undefined,
): string[] {
  if (!patterns || patterns.size === 0) {
    return [];
  }
  const servers = new Set<string>();
  for (const policy of policies) {
    for (const deniedName of expandToolGroups(policy?.deny ?? [])) {
      const serverName = patterns.get(normalizeToolPolicyName(deniedName));
      if (serverName !== undefined) {
        servers.add(serverName);
      }
    }
  }
  return [...servers].toSorted((left, right) => left.localeCompare(right));
}
