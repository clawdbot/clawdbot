import type { FailoverReason } from "../agents/embedded-agent-helpers/types.js";

/** Provider-owned failover error classification input. */
export type ProviderFailoverErrorContext = {
  provider?: string;
  modelId?: string;
  errorMessage: string;
  status?: number;
  code?: string;
  errorType?: string;
};

/** Leaf view of the provider fields needed by synchronous error dispatch. */
export type ProviderFailoverHook = {
  id: string;
  aliases?: readonly string[];
  hookAliases?: readonly string[];
  classifyFailoverReason?: (
    context: ProviderFailoverErrorContext,
  ) => FailoverReason | null | undefined;
};
