// Normalizes MCP server config for runtime launch and validation.
import { isRecord } from "../utils.js";
import { readSourceConfigSnapshot } from "./io.js";
import {
  canonicalizeConfiguredMcpServer,
  normalizeConfiguredMcpServers,
} from "./mcp-config-normalize.js";
import { replaceConfigFile } from "./mutate.js";
import { restoreRedactedValues } from "./redact-snapshot.js";
import { buildConfigSchema } from "./schema.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

type ConfigMcpServers = ReturnType<typeof normalizeConfiguredMcpServers>;

type ConfigMcpReadResult =
  | {
      ok: true;
      path: string;
      config: OpenClawConfig;
      mcpServers: ConfigMcpServers;
      baseHash?: string;
    }
  | { ok: false; path: string; error: string };

type ConfigMcpWriteResult =
  | {
      ok: true;
      path: string;
      config: OpenClawConfig;
      mcpServers: ConfigMcpServers;
      removed?: boolean;
      updated?: boolean;
    }
  | { ok: false; path: string; error: string };

/** Include/exclude tool selection stored for a configured MCP server. */
type McpServerToolSelection = {
  include?: string[];
  exclude?: string[];
};

function normalizeToolSelectionList(value: readonly string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = Array.from(
    new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)),
  ).toSorted((a, b) => a.localeCompare(b));
  return normalized.length > 0 ? normalized : undefined;
}

export async function listConfiguredMcpServers(): Promise<ConfigMcpReadResult> {
  const snapshot = await readSourceConfigSnapshot();
  if (!snapshot.valid) {
    return {
      ok: false,
      path: snapshot.path,
      error: "Config file is invalid; fix it before using MCP config commands.",
    };
  }
  const sourceConfig = snapshot.sourceConfig ?? snapshot.resolved;
  return {
    ok: true,
    path: snapshot.path,
    config: structuredClone(sourceConfig),
    mcpServers: normalizeConfiguredMcpServers(sourceConfig.mcp?.servers),
    baseHash: snapshot.hash,
  };
}

async function updateConfiguredMcpServerConfig(params: {
  name: string;
  update: (server: Record<string, unknown>) => Record<string, unknown>;
  errorLabel: string;
}): Promise<ConfigMcpWriteResult> {
  const name = params.name.trim();
  if (!name) {
    return { ok: false, path: "", error: "MCP server name is required." };
  }

  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    return loaded;
  }
  if (!Object.hasOwn(loaded.mcpServers, name)) {
    return {
      ok: true,
      path: loaded.path,
      config: loaded.config,
      mcpServers: loaded.mcpServers,
      updated: false,
    };
  }

  const next = structuredClone(loaded.config);
  const servers = normalizeConfiguredMcpServers(next.mcp?.servers);
  servers[name] = params.update({ ...servers[name] });
  next.mcp = {
    ...next.mcp,
    servers,
  };

  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      ok: false,
      path: loaded.path,
      error: `Config invalid after MCP ${params.errorLabel} (${issue.path}: ${issue.message}).`,
    };
  }
  await replaceConfigFile({
    nextConfig: validated.config,
    baseHash: loaded.baseHash,
  });
  return {
    ok: true,
    path: loaded.path,
    config: validated.config,
    mcpServers: servers,
    updated: true,
  };
}

export async function updateConfiguredMcpServerTools(params: {
  name: string;
  tools: McpServerToolSelection | null;
}): Promise<ConfigMcpWriteResult> {
  return updateConfiguredMcpServerConfig({
    name: params.name,
    errorLabel: "tool selection update",
    update: (server) => {
      if (params.tools === null) {
        delete server.toolFilter;
      } else {
        const include = normalizeToolSelectionList(params.tools.include);
        const exclude = normalizeToolSelectionList(params.tools.exclude);
        if (include || exclude) {
          server.toolFilter = {
            ...(include ? { include } : {}),
            ...(exclude ? { exclude } : {}),
          };
        } else {
          delete server.toolFilter;
        }
      }
      return server;
    },
  });
}

export async function updateConfiguredMcpServer(params: {
  name: string;
  update: (server: Record<string, unknown>) => Record<string, unknown>;
}): Promise<ConfigMcpWriteResult> {
  return updateConfiguredMcpServerConfig({
    name: params.name,
    errorLabel: "configure",
    update: (server) => canonicalizeConfiguredMcpServer(params.update(server)),
  });
}

export async function setConfiguredMcpServer(params: {
  name: string;
  server: unknown;
}): Promise<ConfigMcpWriteResult> {
  const name = params.name.trim();
  if (!name) {
    return { ok: false, path: "", error: "MCP server name is required." };
  }
  if (!isRecord(params.server)) {
    return { ok: false, path: "", error: "MCP server config must be a JSON object." };
  }

  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    return loaded;
  }

  // Restore redaction sentinels from the existing server entry so a show→set
  // round-trip cannot replace real credentials with the display placeholder.
  const restored = restoreRedactedValues(
    { mcp: { servers: { [name]: params.server } } },
    { mcp: { servers: loaded.mcpServers } },
    buildConfigSchema().uiHints,
  );
  if (!restored.ok) {
    return {
      ok: false,
      path: loaded.path,
      error:
        restored.humanReadableMessage ??
        "MCP server config contains an unrestorable redacted value.",
    };
  }
  const restoredServer = (restored.result as { mcp?: { servers?: Record<string, unknown> } }).mcp
    ?.servers?.[name];
  if (!isRecord(restoredServer)) {
    return { ok: false, path: loaded.path, error: "MCP server config must be a JSON object." };
  }

  const next = structuredClone(loaded.config);
  const servers = normalizeConfiguredMcpServers(next.mcp?.servers);
  servers[name] = canonicalizeConfiguredMcpServer(restoredServer);
  next.mcp = {
    ...next.mcp,
    servers,
  };

  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      ok: false,
      path: loaded.path,
      error: `Config invalid after MCP set (${issue.path}: ${issue.message}).`,
    };
  }
  await replaceConfigFile({
    nextConfig: validated.config,
    baseHash: loaded.baseHash,
  });
  return {
    ok: true,
    path: loaded.path,
    config: validated.config,
    mcpServers: servers,
  };
}

export async function unsetConfiguredMcpServer(params: {
  name: string;
}): Promise<ConfigMcpWriteResult> {
  const name = params.name.trim();
  if (!name) {
    return { ok: false, path: "", error: "MCP server name is required." };
  }

  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    return loaded;
  }
  if (!Object.hasOwn(loaded.mcpServers, name)) {
    return {
      ok: true,
      path: loaded.path,
      config: loaded.config,
      mcpServers: loaded.mcpServers,
      removed: false,
    };
  }

  const next = structuredClone(loaded.config);
  const servers = normalizeConfiguredMcpServers(next.mcp?.servers);
  delete servers[name];
  if (Object.keys(servers).length > 0) {
    next.mcp = {
      ...next.mcp,
      servers,
    };
  } else if (next.mcp) {
    delete next.mcp.servers;
    if (Object.keys(next.mcp).length === 0) {
      delete next.mcp;
    }
  }

  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      ok: false,
      path: loaded.path,
      error: `Config invalid after MCP unset (${issue.path}: ${issue.message}).`,
    };
  }
  await replaceConfigFile({
    nextConfig: validated.config,
    baseHash: loaded.baseHash,
  });
  return {
    ok: true,
    path: loaded.path,
    config: validated.config,
    mcpServers: servers,
    removed: true,
  };
}
