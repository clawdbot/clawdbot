/**
 * Public Amazon Bedrock Mantle API barrel for discovery and bearer-token
 * helpers shared by config, runtime, and tests.
 */
export {
  discoverMantleModels,
  generateBearerTokenFromIam,
  getCachedIamToken,
  MANTLE_IAM_TOKEN_MARKER,
  mergeImplicitMantleProvider,
  resetIamTokenCacheForTest,
  resetMantleDiscoveryCacheForTest,
  resolveImplicitMantleProvider,
  resolveMantleBearerToken,
  resolveMantleRuntimeBearerToken,
} from "./discovery.js";
