import type { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import type { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import type { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import type { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";

export type PreparedStreamRuntime = {
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  cache: {
    observabilityEnabled: boolean;
    promptTools: ReturnType<typeof installEmbeddedAttemptStreamGuards>["promptCacheTools"];
  };
  history: Awaited<ReturnType<typeof prepareEmbeddedAttemptHistory>>;
  isProbeSession: boolean;
  onBlockReplyFlush: Parameters<typeof prepareEmbeddedAttemptStream>[0]["onBlockReplyFlush"];
  promptActiveSession: (
    prompt: string,
    options?: Parameters<
      Parameters<typeof prepareEmbeddedAttemptStream>[0]["activeSession"]["prompt"]
    >[1],
  ) => Promise<void>;
  stream: ReturnType<typeof prepareEmbeddedAttemptStream>;
  timeout: ReturnType<typeof prepareEmbeddedAttemptTimeout>;
};
