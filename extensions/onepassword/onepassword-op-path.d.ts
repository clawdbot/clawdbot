export class OnePasswordCliPathTrustError extends Error {}

export function resolveTrustedOnePasswordCli(options?: {
  configuredPath?: string;
  pathEnv?: string;
}): Promise<string | undefined>;
