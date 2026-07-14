// Memory Wiki helper module supports config behavior.
import os from "node:os";
import path from "node:path";
import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import { resolveDefaultAgentId, resolveSessionAgentId } from "openclaw/plugin-sdk/memory-host-core";
import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";
import type { OpenClawConfig } from "../api.js";

const WIKI_VAULT_MODES = ["isolated", "bridge", "unsafe-local"] as const;
const WIKI_VAULT_SCOPES = ["global", "agent"] as const;
const WIKI_RENDER_MODES = ["native", "obsidian"] as const;
export const WIKI_SEARCH_BACKENDS = ["shared", "local"] as const;
export const WIKI_SEARCH_CORPORA = ["wiki", "memory", "all"] as const;

type WikiVaultMode = (typeof WIKI_VAULT_MODES)[number];
type WikiVaultScope = (typeof WIKI_VAULT_SCOPES)[number];
type WikiRenderMode = (typeof WIKI_RENDER_MODES)[number];
export type WikiSearchBackend = (typeof WIKI_SEARCH_BACKENDS)[number];
export type WikiSearchCorpus = (typeof WIKI_SEARCH_CORPORA)[number];

export type MemoryWikiPluginConfig = {
  vaultMode?: WikiVaultMode;
  vault?: {
    scope?: WikiVaultScope;
    path?: string;
    renderMode?: WikiRenderMode;
  };
  obsidian?: {
    enabled?: boolean;
    useOfficialCli?: boolean;
    vaultName?: string;
    openAfterWrites?: boolean;
  };
  bridge?: {
    enabled?: boolean;
    readMemoryArtifacts?: boolean;
    indexDreamReports?: boolean;
    indexDailyNotes?: boolean;
    indexMemoryRoot?: boolean;
    followMemoryEvents?: boolean;
  };
  unsafeLocal?: {
    allowPrivateMemoryCoreAccess?: boolean;
    paths?: string[];
  };
  ingest?: {
    autoCompile?: boolean;
    maxConcurrentJobs?: number;
    allowUrlIngest?: boolean;
  };
  search?: {
    backend?: WikiSearchBackend;
    corpus?: WikiSearchCorpus;
  };
  context?: {
    includeCompiledDigestPrompt?: boolean;
  };
  render?: {
    preserveHumanBlocks?: boolean;
    createBacklinks?: boolean;
    createDashboards?: boolean;
  };
};

export type ResolvedMemoryWikiConfig = {
  agentId?: string;
  vaultMode: WikiVaultMode;
  vault: {
    scope: WikiVaultScope;
    path: string;
    renderMode: WikiRenderMode;
  };
  obsidian: {
    enabled: boolean;
    useOfficialCli: boolean;
    vaultName?: string;
    openAfterWrites: boolean;
  };
  bridge: {
    enabled: boolean;
    readMemoryArtifacts: boolean;
    indexDreamReports: boolean;
    indexDailyNotes: boolean;
    indexMemoryRoot: boolean;
    followMemoryEvents: boolean;
  };
  unsafeLocal: {
    allowPrivateMemoryCoreAccess: boolean;
    paths: string[];
  };
  ingest: {
    autoCompile: boolean;
    maxConcurrentJobs: number;
    allowUrlIngest: boolean;
  };
  search: {
    backend: WikiSearchBackend;
    corpus: WikiSearchCorpus;
  };
  context: {
    includeCompiledDigestPrompt: boolean;
  };
  render: {
    preserveHumanBlocks: boolean;
    createBacklinks: boolean;
    createDashboards: boolean;
  };
};

export type MemoryWikiConfigResolver = (
  agentId?: string,
  appConfig?: OpenClawConfig,
) => ResolvedMemoryWikiConfig;

export const DEFAULT_WIKI_VAULT_MODE: WikiVaultMode = "isolated";
export const DEFAULT_WIKI_VAULT_SCOPE: WikiVaultScope = "global";
export const DEFAULT_WIKI_RENDER_MODE: WikiRenderMode = "native";
export const DEFAULT_WIKI_SEARCH_BACKEND: WikiSearchBackend = "shared";
export const DEFAULT_WIKI_SEARCH_CORPUS: WikiSearchCorpus = "wiki";

const MemoryWikiConfigSource = z
  .strictObject({
    vaultMode: z.enum(WIKI_VAULT_MODES).optional(),
    vault: z
      .strictObject({
        scope: z.enum(WIKI_VAULT_SCOPES).optional(),
        path: z.string().optional(),
        renderMode: z.enum(WIKI_RENDER_MODES).optional(),
      })
      .optional(),
    obsidian: z
      .strictObject({
        enabled: z.boolean().optional(),
        useOfficialCli: z.boolean().optional(),
        vaultName: z.string().optional(),
        openAfterWrites: z.boolean().optional(),
      })
      .optional(),
    bridge: z
      .strictObject({
        enabled: z.boolean().optional(),
        readMemoryArtifacts: z.boolean().optional(),
        indexDreamReports: z.boolean().optional(),
        indexDailyNotes: z.boolean().optional(),
        indexMemoryRoot: z.boolean().optional(),
        followMemoryEvents: z.boolean().optional(),
      })
      .optional(),
    unsafeLocal: z
      .strictObject({
        allowPrivateMemoryCoreAccess: z.boolean().optional(),
        paths: z.array(z.string()).optional(),
      })
      .optional(),
    ingest: z
      .strictObject({
        autoCompile: z.boolean().optional(),
        maxConcurrentJobs: z.number().int().min(1).optional(),
        allowUrlIngest: z.boolean().optional(),
      })
      .optional(),
    search: z
      .strictObject({
        backend: z.enum(WIKI_SEARCH_BACKENDS).optional(),
        corpus: z.enum(WIKI_SEARCH_CORPORA).optional(),
      })
      .optional(),
    context: z
      .strictObject({
        includeCompiledDigestPrompt: z.boolean().optional(),
      })
      .optional(),
    render: z
      .strictObject({
        preserveHumanBlocks: z.boolean().optional(),
        createBacklinks: z.boolean().optional(),
        createDashboards: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.vault?.scope === "agent" && value.vaultMode === "unsafe-local") {
      ctx.addIssue({
        code: "custom",
        path: ["vaultMode"],
        message: "vaultMode=unsafe-local cannot be combined with vault.scope=agent",
      });
    }
    if (value.vault?.scope === "agent" && value.obsidian?.useOfficialCli === true) {
      ctx.addIssue({
        code: "custom",
        path: ["obsidian", "useOfficialCli"],
        message: "obsidian.useOfficialCli cannot be enabled with vault.scope=agent",
      });
    }
  });

const memoryWikiConfigSchemaBase = buildPluginConfigSchema(MemoryWikiConfigSource, {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: resolveMemoryWikiConfig(undefined) };
    }
    const result = MemoryWikiConfigSource.safeParse(value);
    if (result.success) {
      return { success: true, data: resolveMemoryWikiConfig(result.data) };
    }
    return {
      success: false,
      error: {
        issues: mapPluginConfigIssues(result.error.issues),
      },
    };
  },
});

export const memoryWikiConfigSchema: OpenClawPluginConfigSchema = memoryWikiConfigSchemaBase;

function expandHomePath(inputPath: string, homedir: string): string {
  if (inputPath === "~") {
    return homedir;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(homedir, inputPath.slice(2));
  }
  return inputPath;
}

export function resolveDefaultMemoryWikiVaultPath(homedir = os.homedir()): string {
  return path.join(homedir, ".openclaw", "wiki", "main");
}

export function resolveDefaultMemoryWikiVaultRoot(homedir = os.homedir()): string {
  return path.join(homedir, ".openclaw", "wiki");
}

export function resolveMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
  options?: { homedir?: string },
): ResolvedMemoryWikiConfig {
  const homedir = options?.homedir ?? os.homedir();
  const parsed = config ? MemoryWikiConfigSource.safeParse(config) : null;
  const safeConfig = parsed?.success ? parsed.data : (config ?? {});
  const vaultScope = safeConfig.vault?.scope ?? DEFAULT_WIKI_VAULT_SCOPE;

  return {
    vaultMode: safeConfig.vaultMode ?? DEFAULT_WIKI_VAULT_MODE,
    vault: {
      scope: vaultScope,
      path: expandHomePath(
        safeConfig.vault?.path ??
          (vaultScope === "agent"
            ? resolveDefaultMemoryWikiVaultRoot(homedir)
            : resolveDefaultMemoryWikiVaultPath(homedir)),
        homedir,
      ),
      renderMode: safeConfig.vault?.renderMode ?? DEFAULT_WIKI_RENDER_MODE,
    },
    obsidian: {
      enabled: safeConfig.obsidian?.enabled ?? false,
      useOfficialCli: safeConfig.obsidian?.useOfficialCli ?? false,
      ...(safeConfig.obsidian?.vaultName ? { vaultName: safeConfig.obsidian.vaultName } : {}),
      openAfterWrites: safeConfig.obsidian?.openAfterWrites ?? false,
    },
    bridge: {
      enabled: safeConfig.bridge?.enabled ?? false,
      readMemoryArtifacts: safeConfig.bridge?.readMemoryArtifacts ?? true,
      indexDreamReports: safeConfig.bridge?.indexDreamReports ?? true,
      indexDailyNotes: safeConfig.bridge?.indexDailyNotes ?? true,
      indexMemoryRoot: safeConfig.bridge?.indexMemoryRoot ?? true,
      followMemoryEvents: safeConfig.bridge?.followMemoryEvents ?? true,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: safeConfig.unsafeLocal?.allowPrivateMemoryCoreAccess ?? false,
      paths: safeConfig.unsafeLocal?.paths ?? [],
    },
    ingest: {
      autoCompile: safeConfig.ingest?.autoCompile ?? true,
      maxConcurrentJobs: safeConfig.ingest?.maxConcurrentJobs ?? 1,
      allowUrlIngest: safeConfig.ingest?.allowUrlIngest ?? true,
    },
    search: {
      backend: safeConfig.search?.backend ?? DEFAULT_WIKI_SEARCH_BACKEND,
      corpus: safeConfig.search?.corpus ?? DEFAULT_WIKI_SEARCH_CORPUS,
    },
    context: {
      includeCompiledDigestPrompt: safeConfig.context?.includeCompiledDigestPrompt ?? false,
    },
    render: {
      preserveHumanBlocks: safeConfig.render?.preserveHumanBlocks ?? true,
      createBacklinks: safeConfig.render?.createBacklinks ?? true,
      createDashboards: safeConfig.render?.createDashboards ?? true,
    },
  };
}

export function resolveMemoryWikiConfiguredAgentIds(
  appConfig: OpenClawConfig | undefined,
): string[] {
  const configured = appConfig?.agents?.list ?? [];
  const ids = configured.flatMap((entry) => {
    const rawId = entry?.id?.trim();
    if (!rawId) {
      return [];
    }
    return [resolveSessionAgentId({ config: appConfig, agentId: rawId })];
  });
  return [...new Set(ids.length > 0 ? ids : [resolveDefaultAgentId(appConfig ?? {})])];
}

/** Resolve the exact vault for one trusted runtime agent context. */
export function resolveMemoryWikiAgentConfig(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
}): ResolvedMemoryWikiConfig {
  if (params.config.vault.scope === "global") {
    return params.config;
  }
  if (params.config.vaultMode === "unsafe-local") {
    throw new Error("memory-wiki vault.scope=agent does not support vaultMode=unsafe-local.");
  }

  const configuredAgentIds = resolveMemoryWikiConfiguredAgentIds(params.appConfig);
  const requestedAgentId = params.agentId?.trim();
  if (!requestedAgentId && configuredAgentIds.length > 1) {
    throw new Error("agentId is required for memory-wiki when vault.scope=agent.");
  }
  const agentId = resolveSessionAgentId({
    config: params.appConfig,
    agentId: requestedAgentId ?? resolveDefaultAgentId(params.appConfig ?? {}),
  });
  if (!configuredAgentIds.includes(agentId)) {
    throw new Error(`Unknown memory-wiki agentId: ${requestedAgentId ?? agentId}.`);
  }

  return {
    ...params.config,
    agentId,
    vault: {
      ...params.config.vault,
      path: path.join(params.config.vault.path, agentId),
    },
  };
}
