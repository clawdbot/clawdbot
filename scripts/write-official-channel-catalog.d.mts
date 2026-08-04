export const OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH: "scripts/lib/official-external-channel-catalog.json";
export const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH: "dist/channel-catalog.json";
export const OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH: "docs/channels/index.md";
export const OFFICIAL_CHANNEL_DOCS_NAV_RELATIVE_PATH: "docs/docs.json";

export function buildOfficialChannelCatalog(params?: { repoRoot?: string; cwd?: string }): {
  entries: Array<{
    name: string;
    version?: string;
    description?: string;
    source?: string;
    kind?: string;
    openclaw: {
      plugin?: Record<string, unknown>;
      catalog?: Record<string, unknown>;
      contracts?: Record<string, string[] | undefined>;
      channel: Record<string, unknown>;
      channelConfigs?: Record<string, { schema?: unknown }>;
      providerEndpoints?: Array<Record<string, unknown>>;
      install: {
        clawhubSpec?: string;
        npmSpec?: string;
        localPath?: string;
        defaultChoice?: "clawhub" | "npm" | "local";
        minHostVersion?: string;
        expectedIntegrity?: string;
        allowInvalidConfigRecovery?: boolean;
      };
    };
  }>;
};

export function renderOfficialChannelCatalog(params?: { repoRoot?: string; cwd?: string }): string;
export function writeOfficialChannelCatalog(params?: { repoRoot?: string; cwd?: string }): boolean;
export function writeOfficialChannelCatalogSource(params?: {
  repoRoot?: string;
  cwd?: string;
}): boolean;
export function checkOfficialChannelCatalogSource(params?: {
  repoRoot?: string;
  cwd?: string;
}): boolean;

export function buildOfficialChannelDocsCatalog(params?: { repoRoot?: string; cwd?: string }): {
  entries: Array<{
    id: string;
    label: string;
    docsPath: string;
    summary: string;
    source: "official" | "external" | "bundled" | "built-in";
  }>;
};

export function renderOfficialChannelDocsIndex(params?: {
  repoRoot?: string;
  cwd?: string;
}): string;
export function writeOfficialChannelDocsIndex(params?: {
  repoRoot?: string;
  cwd?: string;
}): boolean;
export function checkOfficialChannelDocsIndex(params?: {
  repoRoot?: string;
  cwd?: string;
}): boolean;
export function findMissingOfficialChannelDocsNavRoutes(params?: {
  repoRoot?: string;
  cwd?: string;
}): string[];
export function findUnexpectedOfficialChannelDocsNavRoutes(params?: {
  repoRoot?: string;
  cwd?: string;
}): string[];
export function findDuplicateOfficialChannelDocsNavRoutes(params?: {
  repoRoot?: string;
  cwd?: string;
}): string[];
