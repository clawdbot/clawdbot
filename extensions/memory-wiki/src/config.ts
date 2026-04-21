import os from "node:os";
import path from "node:path";
import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";

export const WIKI_VAULT_MODES = ["isolated", "bridge", "unsafe-local"] as const;
export const WIKI_RENDER_MODES = ["native", "obsidian"] as const;
export const WIKI_SEARCH_BACKENDS = ["shared", "local"] as const;
export const WIKI_SEARCH_CORPORA = ["wiki", "memory", "all"] as const;

export type WikiVaultMode = (typeof WIKI_VAULT_MODES)[number];
export type WikiRenderMode = (typeof WIKI_RENDER_MODES)[number];
export type WikiSearchBackend = (typeof WIKI_SEARCH_BACKENDS)[number];
export type WikiSearchCorpus = (typeof WIKI_SEARCH_CORPORA)[number];

export type MemoryWikiPluginConfig = {
  vaultMode?: WikiVaultMode;
  vault?: {
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
  vaultMode: WikiVaultMode;
  vault: {
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

export const DEFAULT_WIKI_VAULT_MODE: WikiVaultMode = "isolated";
export const DEFAULT_WIKI_RENDER_MODE: WikiRenderMode = "native";
export const DEFAULT_WIKI_SEARCH_BACKEND: WikiSearchBackend = "shared";
export const DEFAULT_WIKI_SEARCH_CORPUS: WikiSearchCorpus = "wiki";

const MemoryWikiConfigSource = z.strictObject({
  vaultMode: z.enum(WIKI_VAULT_MODES).optional(),
  vault: z
    .strictObject({
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

export function resolveMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
  options?: { homedir?: string },
): ResolvedMemoryWikiConfig {
  const homedir = options?.homedir ?? os.homedir();
  const parsed = config ? MemoryWikiConfigSource.safeParse(config) : null;
  const safeConfig = parsed?.success ? parsed.data : (config ?? {});

  return {
    vaultMode: safeConfig.vaultMode ?? DEFAULT_WIKI_VAULT_MODE,
    vault: {
      path: expandHomePath(
        safeConfig.vault?.path ?? resolveDefaultMemoryWikiVaultPath(homedir),
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
