export type PrewarmedPluginCacheEntry = {
  pluginId: string;
  packageName: string;
  packageVersion: string;
  npmSpec: string;
  archiveFile: string;
  archiveSHA256: string;
};

export type PrewarmedPluginCacheManifest = {
  schemaVersion: 1;
  appVersion: string;
  gitCommit: string;
  plugins: PrewarmedPluginCacheEntry[];
};

export type VerifyPrewarmedPluginCacheParams = {
  sourceDir: string;
  expectedVersion: string;
  expectedCommit: string;
  expectedManifestSha256?: string;
};

export function sha256File(filePath: string): string;

export function verifyPrewarmedPluginCache(
  params: VerifyPrewarmedPluginCacheParams,
): PrewarmedPluginCacheManifest;

export function stageVerifiedPrewarmedPluginCache(
  params: VerifyPrewarmedPluginCacheParams & { stageDir: string },
): PrewarmedPluginCacheManifest;
