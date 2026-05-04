export const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH: "dist/channel-catalog.json";

export function buildOfficialChannelCatalog(params?: { repoRoot?: string; cwd?: string }): {
  entries: Array<{
    name: string;
    version?: string;
    description?: string;
    openclaw: {
      channel: Record<string, unknown>;
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

export function writeOfficialChannelCatalog(params?: { repoRoot?: string; cwd?: string }): void;
