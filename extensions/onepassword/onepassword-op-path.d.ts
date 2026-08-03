export function resolveTrustedOnePasswordDirectoryPath(targetPath: string): Promise<string>;

export function resolveTrustedOnePasswordCli(options?: {
  configuredPath?: string;
  pathEnv?: string;
}): Promise<string | undefined>;
