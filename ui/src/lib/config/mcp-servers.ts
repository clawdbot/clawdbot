import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "./index.ts";

export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export type McpServerTransport = "streamable-http" | "sse" | "stdio";

export type McpServerSummary = {
  name: string;
  enabled: boolean;
  transport: McpServerTransport | "invalid";
  target: string;
  auth: string | null;
  toolFilter: boolean;
  parallel: boolean;
  tls: "verify-off" | "mtls" | null;
};

export type McpServersPatchBuildResult = { patch: Record<string, unknown> } | { error: string };

function splitMcpCommandLine(value: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (char === "\\" && quote === '"') {
      let slashCount = 1;
      while (value[index + slashCount] === "\\") {
        slashCount += 1;
      }
      const next = value[index + slashCount];
      if (next === '"') {
        current += "\\".repeat(Math.floor(slashCount / 2));
        if (slashCount % 2 === 0) {
          quote = null;
        } else {
          current += '"';
        }
        index += slashCount;
      } else {
        current += "\\".repeat(slashCount);
        index += slashCount - 1;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "\\" && quote === null) {
      const next = value[index + 1];
      if (next && (next === '"' || next === "'" || /\s/u.test(next))) {
        current += next;
        tokenStarted = true;
        index += 1;
      } else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (tokenStarted) {
        parts.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }

  if (quote) {
    return null;
  }
  if (tokenStarted) {
    parts.push(current);
  }
  return parts;
}

export function parseMcpTarget(
  target: string,
  transport: McpServerTransport,
): Record<string, unknown> | null {
  if (transport !== "stdio") {
    return /^https?:\/\//i.test(target) ? { url: target, transport } : null;
  }
  if (/^https?:\/\//i.test(target)) {
    return null;
  }
  const [command, ...args] = splitMcpCommandLine(target.trim()) ?? [];
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
      const transport = command
        ? ("stdio" as const)
        : url
          ? server.transport === "streamable-http"
            ? ("streamable-http" as const)
            : server.transport === undefined || server.transport === "sse"
              ? ("sse" as const)
              : ("invalid" as const)
          : ("invalid" as const);
      return {
        name,
        enabled: server.enabled !== false,
        transport,
        target: command || redactSensitiveUrlLikeString(url),
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
 * The builder runs after pending editor writes settle so duplicate/existence
 * decisions use the same snapshot as the patch base hash. config.patch uses
 * RFC 7396 semantics, so return a minimal fragment with explicit deletion nulls.
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
    const patched = await runtimeConfig.patchFromSnapshot((base) => {
      const servers = asRecord(asRecord(base.mcp)?.servers) ?? {};
      const built = options.buildPatch(servers);
      return "error" in built
        ? built
        : {
            options: {
              raw: { mcp: { servers: built.patch } },
              note: options.note,
            },
          };
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
