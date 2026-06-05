/**
 * AWS shared config cache refresh helpers for Bedrock. They nudge the AWS SDK
 * to re-read profile/SSO config when no static credentials are present.
 */
type SharedIniFileLoader = {
  loadSharedConfigFiles(init?: { ignoreCache?: boolean }): Promise<unknown>;
};

let sharedIniFileLoaderForTest: SharedIniFileLoader | null | undefined;

function hasStaticAwsCredentialEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

/** Return whether Bedrock should refresh the AWS shared config cache before discovery. */
export function shouldRefreshAwsSharedConfigCacheForBedrock(env: NodeJS.ProcessEnv): boolean {
  if (env.AWS_BEDROCK_SKIP_AUTH === "1" || env.AWS_BEARER_TOKEN_BEDROCK) {
    return false;
  }
  return !hasStaticAwsCredentialEnv(env);
}

async function loadSharedIniFileLoader(): Promise<SharedIniFileLoader> {
  if (sharedIniFileLoaderForTest !== undefined) {
    if (!sharedIniFileLoaderForTest) {
      throw new Error("AWS shared INI file loader unavailable");
    }
    return sharedIniFileLoaderForTest;
  }
  return (await import("@smithy/shared-ini-file-loader")) as SharedIniFileLoader;
}

/** Refresh Smithy shared config files when Bedrock needs default-chain credentials. */
export async function refreshAwsSharedConfigCacheForBedrock(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!shouldRefreshAwsSharedConfigCacheForBedrock(env)) {
    return;
  }
  const loader = await loadSharedIniFileLoader();
  await loader.loadSharedConfigFiles({ ignoreCache: true });
}

/** Override the shared INI loader for Bedrock credential-refresh tests. */
export function setAwsSharedIniFileLoaderForTest(
  loader: SharedIniFileLoader | null | undefined,
): void {
  sharedIniFileLoaderForTest = loader;
}
