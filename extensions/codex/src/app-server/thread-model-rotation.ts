import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";
import { resolveCodexAppServerThreadModelSelection } from "./thread-model-selection.js";

export async function rotateChangedCodexExecutionModel(params: {
  lifecycle: CodexStartOrResumeThreadParams;
  binding: CodexAppServerThreadBinding | undefined;
  clearCurrentBinding: (reason: string) => Promise<void>;
}): Promise<void> {
  const { lifecycle, binding } = params;
  if (!lifecycle.runtimeModelId || !binding?.threadId || !binding.model) {
    return;
  }
  const requested = resolveCodexAppServerThreadModelSelection({
    provider: lifecycle.params.provider,
    model: lifecycle.runtimeModelId,
    authProfileId: lifecycle.params.authProfileId,
    authProfileStore: lifecycle.params.authProfileStore,
    agentDir: lifecycle.params.agentDir,
    config: lifecycle.params.config,
  });
  const bindingModelRefs = [
    binding.model,
    binding.modelProvider ? `${binding.modelProvider}/${binding.model}` : undefined,
  ];
  const providerChanged =
    requested.modelProvider !== undefined && binding.modelProvider !== requested.modelProvider;
  if (bindingModelRefs.includes(requested.model) && !providerChanged) {
    return;
  }
  embeddedAgentLog.debug("codex app-server execution model changed; starting a new thread", {
    threadId: binding.threadId,
  });
  await params.clearCurrentBinding("rotating a stale execution-model thread binding");
}
