/** Complete provider model fixtures with typed scenario overrides. */
import type { Api, Model } from "openclaw/plugin-sdk/llm";

type ProviderModelFixture<TApi extends Api> = Partial<
  Omit<Model<TApi>, "id" | "provider" | "api" | "baseUrl">
> &
  Pick<Model<TApi>, "id" | "provider" | "baseUrl"> & {
    /** Transport aliases intentionally exercise normalization before the canonical API is restored. */
    api: string;
    /** Guarded transport accepts this provider metadata extension before SDK normalization. */
    requestTimeoutMs?: number;
  };

export function makeProviderModelFixture<TApi extends Api>(
  overrides: ProviderModelFixture<TApi>,
): Model<TApi> {
  return {
    name: overrides.id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 4_096,
    ...overrides,
    api: overrides.api as TApi,
  };
}
