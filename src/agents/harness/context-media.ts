import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Captures media policy before plugin invocation while keeping extraction dependencies lazy. */
export function bindHarnessContextMedia(params: {
  attempt: Partial<EmbeddedRunAttemptParams>;
  config?: OpenClawConfig;
  assertActive: () => void;
}): AgentHarnessHostCapabilities["prepareContextMedia"] {
  const { attempt, config, assertActive } = params;
  if (!attempt.workspaceDir || !attempt.model) {
    return undefined;
  }
  const modelInput = structuredClone(attempt.model.input);
  Object.freeze(modelInput);
  const contextMedia = Object.freeze({
    config,
    workspaceDir: attempt.sandbox?.enabled ? attempt.sandbox.workspaceDir : attempt.workspaceDir,
    modelInput,
    agentId: attempt.agentId,
    channelId: attempt.messageChannel ?? attempt.messageProvider,
    accountId: attempt.agentAccountId,
    ...(attempt.sandbox?.enabled && attempt.sandbox.fsBridge
      ? {
          sandbox: Object.freeze({
            root: attempt.sandbox.workspaceDir,
            bridge: attempt.sandbox.fsBridge,
          }),
        }
      : {}),
  });
  const assertCurrent = () => {
    assertActive();
    attempt.abortSignal?.throwIfAborted();
  };
  return async (request) => {
    assertCurrent();
    const { prepareHarnessContextMedia } = await import("./context-media-runtime.js");
    assertCurrent();
    const result = await prepareHarnessContextMedia({ ...request, ...contextMedia, assertCurrent });
    assertCurrent();
    return result;
  };
}
