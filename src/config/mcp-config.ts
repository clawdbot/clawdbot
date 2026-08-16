// Normalizes MCP server config for runtime launch and validation.
import { expectDefined, stableStringify } from "@openclaw/normalization-core";
import { markClawMcpServerIndependentlyOwned } from "../state/claw-mcp-adoption.js";
import { isRecord } from "../utils.js";
import { readSourceConfigSnapshot } from "./io.js";
import {
  canonicalizeConfiguredMcpServer,
  normalizeConfiguredMcpServers,
} from "./mcp-config-normalize.js";
import { replaceConfigFile } from "./mutate.js";
import { redactSensitiveArgv } from "./redact-argv.js";
import { REDACTED_SENTINEL, restoreRedactedValues } from "./redact-snapshot.js";
import { buildConfigSchemaCore } from "./schema.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

type ConfigMcpServers = ReturnType<typeof normalizeConfiguredMcpServers>;

type McpArgvRestoreResult =
  | { ok: true; server: Record<string, unknown> }
  | { ok: false; error: string };

type ConfigMcpSuccess = {
  path: string;
  config: OpenClawConfig;
  mcpServers: ConfigMcpServers;
};
type ConfigMcpFailure = { ok: false; path: string; error: string };
type ConfigMcpReadResult = (ConfigMcpSuccess & { ok: true; baseHash?: string }) | ConfigMcpFailure;
type ConfigMcpWriteResult =
  | (ConfigMcpSuccess & { ok: true; removed?: boolean; updated?: boolean })
  | ConfigMcpFailure;

type LoadedConfigMcpServers = Extract<ConfigMcpReadResult, { ok: true }>;
type McpConfigMutation = {
  name: string;
  previous?: Record<string, unknown>;
  next?: Record<string, unknown>;
};
type McpConfigMutationHook = (mutation: McpConfigMutation) => Promise<void>;

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

function restoreMcpServerArgvSentinels(params: {
  incoming: Record<string, unknown>;
  original: Record<string, unknown> | undefined;
}): McpArgvRestoreResult {
  const incomingArgs = params.incoming.args;
  if (!Array.isArray(incomingArgs)) {
    return { ok: true, server: params.incoming };
  }
  const hasSentinel = incomingArgs.some(
    (arg) => typeof arg === "string" && arg.includes(REDACTED_SENTINEL),
  );
  if (!hasSentinel) {
    return { ok: true, server: params.incoming };
  }

  const originalArgs = params.original?.args;
  if (
    !Array.isArray(originalArgs) ||
    !originalArgs.every((arg) => typeof arg === "string") ||
    incomingArgs.length !== originalArgs.length
  ) {
    return {
      ok: false,
      error: `Cannot restore MCP args containing "${REDACTED_SENTINEL}" without the same original argv shape.`,
    };
  }

  const displayedArgs = redactSensitiveArgv(originalArgs, REDACTED_SENTINEL);
  if (incomingArgs.some((arg, index) => arg !== displayedArgs[index])) {
    return {
      ok: false,
      error: `Cannot restore MCP args containing "${REDACTED_SENTINEL}" after argv changed. Replace every redacted value explicitly before editing args.`,
    };
  }
  return {
    ok: true,
    server: {
      ...params.incoming,
      args: originalArgs,
    },
  };
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

async function commitConfiguredMcpServers(params: {
  loaded: LoadedConfigMcpServers;
  servers: ConfigMcpServers;
  errorLabel: string;
  success?: { removed?: boolean; updated?: boolean };
  independentlyOwnedName?: string;
  mutation?: { name: string; onCommitted?: McpConfigMutationHook };
}): Promise<ConfigMcpWriteResult> {
  const next = structuredClone(params.loaded.config);
  if (Object.keys(params.servers).length > 0) {
    next.mcp = { ...next.mcp, servers: params.servers };
  } else if (next.mcp) {
    delete next.mcp.servers;
    if (Object.keys(next.mcp).length === 0) {
      delete next.mcp;
    }
  }

  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = expectDefined(validated.issues[0], "issues entry at 0");
    return {
      ok: false,
      path: params.loaded.path,
      error: `Config invalid after MCP ${params.errorLabel} (${issue.path}: ${issue.message}).`,
    };
  }
  await replaceConfigFile({
    nextConfig: validated.config,
    baseHash: params.loaded.baseHash,
  });
  if (params.mutation?.onCommitted) {
    const previous = params.loaded.mcpServers[params.mutation.name];
    const nextServer = params.servers[params.mutation.name];
    await params.mutation.onCommitted({
      name: params.mutation.name,
      ...(previous ? { previous } : {}),
      ...(nextServer ? { next: nextServer } : {}),
    });
  }
  if (params.independentlyOwnedName) {
    markClawMcpServerIndependentlyOwned(params.independentlyOwnedName);
  }
  return {
    ok: true,
    path: params.loaded.path,
    config: validated.config,
    mcpServers: params.servers,
    ...params.success,
  };
}

async function updateConfiguredMcpServerConfig(params: {
  name: string;
  update: (server: Record<string, unknown>) => Record<string, unknown>;
  errorLabel: string;
  recordIndependentOwner?: boolean;
  onCommitted?: McpConfigMutationHook;
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
    const { baseHash: _baseHash, ...unchanged } = loaded;
    return { ...unchanged, updated: false };
  }

  const servers = normalizeConfiguredMcpServers(loaded.config.mcp?.servers);
  servers[name] = params.update({ ...servers[name] });
  return commitConfiguredMcpServers({
    loaded,
    servers,
    errorLabel: params.errorLabel,
    success: { updated: true },
    independentlyOwnedName: params.recordIndependentOwner === false ? undefined : name,
    mutation: { name, onCommitted: params.onCommitted },
  });
}

async function updateConfiguredMcpServerTools(
  params: {
    name: string;
    tools: McpServerToolSelection | null;
    recordIndependentOwner?: boolean;
  },
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
  return updateConfiguredMcpServerConfig({
    name: params.name,
    recordIndependentOwner: params.recordIndependentOwner,
    errorLabel: "tool selection update",
    onCommitted,
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

async function updateConfiguredMcpServer(
  params: {
    name: string;
    update: (server: Record<string, unknown>) => Record<string, unknown>;
    recordIndependentOwner?: boolean;
  },
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
  return updateConfiguredMcpServerConfig({
    name: params.name,
    recordIndependentOwner: params.recordIndependentOwner,
    errorLabel: "configure",
    onCommitted,
    update: (server) => canonicalizeConfiguredMcpServer(params.update(server)),
  });
}

async function setConfiguredMcpServer(
  params: {
    name: string;
    server: unknown;
    createOnly?: boolean;
    recordIndependentOwner?: boolean;
    expectedServer?: Record<string, unknown>;
  },
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
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
  if (params.createOnly && Object.hasOwn(loaded.mcpServers, name)) {
    return {
      ok: false,
      path: loaded.path,
      error: `MCP server ${JSON.stringify(name)} already exists.`,
    };
  }
  const existingServer = loaded.mcpServers[name];
  if (
    params.expectedServer &&
    (!Object.hasOwn(loaded.mcpServers, name) ||
      !existingServer ||
      stableStringify(canonicalizeConfiguredMcpServer(existingServer)) !==
        stableStringify(canonicalizeConfiguredMcpServer(params.expectedServer)))
  ) {
    return {
      ok: false,
      path: loaded.path,
      error: `MCP server ${JSON.stringify(name)} changed and was not updated.`,
    };
  }

  const argvRestored = restoreMcpServerArgvSentinels({
    incoming: params.server,
    original: loaded.mcpServers[name],
  });
  if (!argvRestored.ok) {
    return {
      ok: false,
      path: loaded.path,
      error: argvRestored.error,
    };
  }

  // Restore redaction sentinels from the existing server entry so a show→set
  // round-trip cannot replace real credentials with the display placeholder.
  const restored = restoreRedactedValues(
    { mcp: { servers: { [name]: argvRestored.server } } },
    { mcp: { servers: loaded.mcpServers } },
    buildConfigSchemaCore().uiHints,
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

  const servers = normalizeConfiguredMcpServers(loaded.config.mcp?.servers);
  servers[name] = canonicalizeConfiguredMcpServer(restoredServer);
  return commitConfiguredMcpServers({
    loaded,
    servers,
    errorLabel: "set",
    independentlyOwnedName: params.recordIndependentOwner === false ? undefined : name,
    mutation: { name, onCommitted },
  });
}

async function unsetConfiguredMcpServer(
  params: {
    name: string;
    expectedServer?: Record<string, unknown>;
  },
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
  const name = params.name.trim();
  if (!name) {
    return { ok: false, path: "", error: "MCP server name is required." };
  }

  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    return loaded;
  }
  if (!Object.hasOwn(loaded.mcpServers, name)) {
    const { baseHash: _baseHash, ...unchanged } = loaded;
    return { ...unchanged, removed: false };
  }
  const loadedServer = loaded.mcpServers[name];
  if (
    params.expectedServer &&
    loadedServer &&
    stableStringify(canonicalizeConfiguredMcpServer(loadedServer)) !==
      stableStringify(canonicalizeConfiguredMcpServer(params.expectedServer))
  ) {
    return {
      ok: false,
      path: loaded.path,
      error: `MCP server ${JSON.stringify(name)} changed and was not removed.`,
    };
  }

  const servers = normalizeConfiguredMcpServers(loaded.config.mcp?.servers);
  delete servers[name];
  return commitConfiguredMcpServers({
    loaded,
    servers,
    errorLabel: "unset",
    success: { removed: true },
    mutation: { name, onCommitted },
  });
}

/** Low-level config writers; production mutations must use the agents-owned lifecycle facade. */
export const mcpConfigInternal = {
  set: setConfiguredMcpServer,
  unset: unsetConfiguredMcpServer,
  update: updateConfiguredMcpServer,
  updateTools: updateConfiguredMcpServerTools,
};
