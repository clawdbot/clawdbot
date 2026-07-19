import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig, type RuntimeConfigCapability } from "./index.ts";

export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export type McpServerSummary = {
  name: string;
  enabled: boolean;
  transport: "http" | "stdio" | "invalid";
  target: string;
  auth: string | null;
  toolFilter: boolean;
  parallel: boolean;
  tls: "verify-off" | "mtls" | null;
};

export type McpServersPatchBuildResult = { patch: Record<string, unknown> } | { error: string };

export function parseMcpTarget(target: string): Record<string, unknown> | null {
  if (/^https?:\/\//i.test(target)) {
    // The runtime defaults URL-only servers to SSE; modern MCP endpoints are
    // streamable HTTP unless the /sse path convention says otherwise.
    const transport = /\/sse\/?$/i.test(target.split("?")[0] ?? target) ? "sse" : "streamable-http";
    return { url: target, transport };
  }
  const [command, ...args] = target.trim().split(/\s+/u);
  if (!command) {
    return null;
  }
  return args.length > 0 ? { command, args } : { command };
}

export function summarizeMcpServers(
  config: Record<string, unknown> | null,
): McpServerSummary[] | null {
  if (!config) {
    return null;
  }
  const servers = asRecord(asRecord(config.mcp)?.servers) ?? {};
  return Object.entries(servers)
    .map(([name, value]) => {
      const server = asRecord(value) ?? {};
      const url = typeof server.url === "string" ? server.url : "";
      // Command only: stdio args routinely carry tokens, and this projection
      // is visible to read-only operators.
      const command = typeof server.command === "string" ? server.command : "";
      return {
        name,
        enabled: server.enabled !== false,
        transport: url ? ("http" as const) : command ? ("stdio" as const) : ("invalid" as const),
        target: url ? redactSensitiveUrlLikeString(url) : command,
        auth: typeof server.auth === "string" ? server.auth : null,
        toolFilter: Boolean(server.toolFilter),
        parallel: server.supportsParallelToolCalls === true,
        tls:
          server.sslVerify === false
            ? ("verify-off" as const)
            : server.clientCert || server.clientKey
              ? ("mtls" as const)
              : null,
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function buildAddMcpServerPatch(
  servers: Readonly<Record<string, unknown>>,
  name: string,
  config: Record<string, unknown>,
): McpServersPatchBuildResult {
  return Object.hasOwn(servers, name)
    ? { error: t("mcpServers.nameTaken", { name }) }
    : { patch: { [name]: config } };
}

export function buildToggleMcpServerPatch(
  servers: Readonly<Record<string, unknown>>,
  name: string,
  enabled: boolean,
): McpServersPatchBuildResult {
  if (!Object.hasOwn(servers, name)) {
    return { error: t("mcpServers.missing", { name }) };
  }
  // Enabling deletes the key so the config keeps its enabled-by-default shape.
  return { patch: { [name]: { enabled: enabled ? null : false } } };
}

export function buildRemoveMcpServerPatch(
  servers: Readonly<Record<string, unknown>>,
  name: string,
): McpServersPatchBuildResult {
  return Object.hasOwn(servers, name)
    ? { patch: { [name]: null } }
    : { error: t("mcpServers.missing", { name }) };
}

/**
 * Apply one mutation to config.mcp.servers through the shared config seam.
 * config.patch uses RFC 7396 merge semantics, so `buildPatch` must return a
 * minimal fragment (with explicit nulls for deletions), never a full config.
 */
export async function patchMcpServers(
  runtimeConfig: RuntimeConfigCapability,
  options: {
    buildPatch: (servers: Readonly<Record<string, unknown>>) => McpServersPatchBuildResult;
    note: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runtimeConfig.ensureLoaded();
    const base = resolveEditableSnapshotConfig(runtimeConfig.state.configSnapshot);
    if (!base) {
      return { ok: false, error: t("mcpServers.configUnavailable") };
    }
    const servers = asRecord(asRecord(base.mcp)?.servers) ?? {};
    const built = options.buildPatch(servers);
    if ("error" in built) {
      return { ok: false, error: built.error };
    }
    const patched = await runtimeConfig.patch({
      raw: { mcp: { servers: built.patch } },
      note: options.note,
    });
    if (!patched) {
      return {
        ok: false,
        error: runtimeConfig.state.lastError ?? t("mcpServers.configUnavailable"),
      };
    }
    await runtimeConfig.refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
