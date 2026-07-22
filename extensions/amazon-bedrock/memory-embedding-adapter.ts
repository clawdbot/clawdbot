/**
 * Memory embedding adapter for Amazon Bedrock. It exposes Bedrock embeddings to
 * the memory-core engine and verifies AWS credentials before auto-selection.
 */
import {
  isMissingEmbeddingApiKeyError,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createBedrockEmbeddingProvider,
  DEFAULT_BEDROCK_EMBEDDING_MODEL,
  hasAwsCredentials,
} from "./embedding-provider.js";

/** Memory-core adapter descriptor for Bedrock embeddings. */
export const bedrockMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "bedrock",
  defaultModel: DEFAULT_BEDROCK_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "amazon-bedrock",
  autoSelectPriority: 60,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    if (!(await hasAwsCredentials())) {
      throw new Error(
        'No API key found for provider "bedrock". ' +
          "AWS credentials are not available. " +
          "Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or AWS_BEARER_TOKEN_BEDROCK, " +
          "configure an EC2/ECS/EKS role, " +
          "or set memory.search.provider to another provider.",
      );
    }
    const { provider, client } = await createBedrockEmbeddingProvider({
      ...options,
      provider: "bedrock",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "bedrock",
        cacheKeyData: {
          provider: "bedrock",
          region: client.region,
          model: client.model,
          dimensions: client.dimensions,
        },
      },
    };
  },
};
