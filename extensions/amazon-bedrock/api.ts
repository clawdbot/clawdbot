/**
 * Lightweight Amazon Bedrock API barrel for config and discovery consumers.
 * Keep runtime streaming exports out of this path so metadata flows stay cheap.
 */
export { mergeImplicitBedrockProvider, resolveBedrockConfigApiKey } from "./discovery-shared.js";
export {
  discoverBedrockModels,
  resetBedrockDiscoveryCacheForTest,
  resolveImplicitBedrockProvider,
} from "./discovery.js";
