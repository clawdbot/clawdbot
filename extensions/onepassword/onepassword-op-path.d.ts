export function resolveTrustedExecutablePath(targetPath: string): Promise<string>;

export function resolveTrustedOnePasswordCli(options?: {
  configuredPath?: string;
  pathEnv?: string;
}): Promise<string | undefined>;

export const testing: {
  isSafeWindowsDirectoryAclEntries(
    entries: Array<{ rawRights: string }>,
    allowChildCreation?: boolean,
  ): boolean;
  isSafeWindowsDirectoryAclSummary(
    summary: string | undefined,
    allowChildCreation?: boolean,
  ): boolean;
  isTrustedOwner(
    stat: { uid?: number | null },
    permissions: { ownerTrusted?: boolean; ownerSid?: string },
    platform?: NodeJS.Platform,
    allowWindowsTrustedInstaller?: boolean,
  ): boolean;
};
