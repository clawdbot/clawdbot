/** Collects MCP Server SecretRefs during core runtime preparation. */
import {
  isDangerousMcpStdioEnvVarName,
  mcpUsesManagedAuthorization,
} from "../agents/mcp-config-shared.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import {
  collectRuntimeSecretInputAssignment,
  type ResolverContext,
  type SecretAssignmentOwner,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

export function collectMcpAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const servers = params.config.mcp?.servers;
  if (!servers) {
    return;
  }
  for (const [serverName, server] of Object.entries(servers)) {
    const disabled = server.enabled === false;
    const transport = disabled
      ? null
      : resolveMcpTransportConfig(serverName, server, { logWarnings: false });
    const owner = {
      ownerKind: "capability",
      ownerId: `mcp:${serverName}`,
      requiredForGateway: false,
      disposition: "isolate",
      contract: server,
    } satisfies SecretAssignmentOwner;
    const env = isRecord(server.env) ? server.env : undefined;
    if (env) {
      for (const [envKey, envValue] of Object.entries(env)) {
        if (!isSecretRef(envValue)) {
          continue;
        }
        const blocked = transport?.kind === "stdio" && isDangerousMcpStdioEnvVarName(envKey);
        const active = transport?.kind === "stdio" && !blocked;
        collectRuntimeSecretInputAssignment({
          value: envValue,
          path: `mcp.servers.${serverName}.env.${envKey}`,
          expected: "string",
          defaults: params.defaults,
          context: params.context,
          active,
          inactiveReason: disabled
            ? "MCP server is disabled."
            : blocked
              ? `stdio MCP env key "${envKey}" is blocked by host env safety policy.`
              : "stdio MCP transport is not selected.",
          owner,
          apply: (value) => {
            if (typeof value !== "string") {
              throw new TypeError("Resolved MCP stdio env secret must be a string.");
            }
            env[envKey] = value;
          },
        });
      }
    }
    const headers = isRecord(server.headers) ? server.headers : undefined;
    if (headers) {
      for (const [headerKey, headerValue] of Object.entries(headers)) {
        if (!isSecretRef(headerValue)) {
          continue;
        }
        const authorizationIsReplaced =
          transport?.kind === "http" &&
          headerKey.toLowerCase() === "authorization" &&
          mcpUsesManagedAuthorization(server);
        collectRuntimeSecretInputAssignment({
          value: headerValue,
          path: `mcp.servers.${serverName}.headers.${headerKey}`,
          expected: "string",
          defaults: params.defaults,
          context: params.context,
          active: transport?.kind === "http" && !authorizationIsReplaced,
          inactiveReason: disabled
            ? "MCP server is disabled."
            : authorizationIsReplaced
              ? "Authorization header is replaced by the selected OAuth MCP transport."
              : "HTTP MCP transport is not selected.",
          owner,
          apply: (value) => {
            if (typeof value !== "string") {
              throw new TypeError("Resolved MCP HTTP header secret must be a string.");
            }
            headers[headerKey] = value;
          },
        });
      }
    }
  }
}
