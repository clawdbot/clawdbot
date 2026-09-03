import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerPreparedAuthHandoff } from "./auth-bridge.js";
import { runBoundedCodexAppServerTurn, type CodexBoundedTurnOptions } from "./bounded-turn.js";
import { readCodexPluginConfig, resolveCodexAppServerHomeScope } from "./config.js";
import { createAttributedCodexAssistantMessage } from "./event-projector-assistant-message.js";
import { assertCodexPassiveTurnItems } from "./protocol-validators.js";

type CodexIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>
>[0];
type AgentHarnessIsolatedCompletionResult = Awaited<
  ReturnType<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>
>;

/** Runs prompt-only Codex inference on an ephemeral, ring-zero native thread. */
export async function runCodexIsolatedCompletion(
  params: CodexIsolatedCompletionParams,
  options: CodexBoundedTurnOptions,
): Promise<AgentHarnessIsolatedCompletionResult> {
  const authorization = params.authorization;
  if (authorization.owner !== "harness") {
    throw new Error("Codex native isolated completion requires harness-owned authorization.");
  }
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const authRequirement = authorization.plan.modelRoute?.authRequirement;
  const authHandoff = await resolveCodexAppServerPreparedAuthHandoff({
    authRequirement,
    authProfileId: authorization.plan.forwardedAuthProfileId,
    authProfileStore: authorization.authProfileStore,
    agentDir: params.agentDir,
    homeScope: resolveCodexAppServerHomeScope({ appServer: pluginConfig.appServer }),
    config: params.config,
    subscriptionProfileRequiredError:
      "Prepared Codex subscription route requires a scoped native OAuth or token profile.",
    subscriptionProfileUnusableError: `Prepared Codex auth profile "${authorization.plan.forwardedAuthProfileId}" is unusable.`,
  });
  const authSelection = authHandoff.preparedAuth
    ? { preparedAuth: authHandoff.preparedAuth }
    : { profile: authHandoff.authProfileId };
  const result = await runBoundedCodexAppServerTurn({
    config: params.config,
    model: {
      mode: "required",
      id: params.modelId,
    },
    ...authSelection,
    authRequirement,
    timeoutMs: params.timeoutMs,
    signal: params.abortSignal,
    agentDir: params.agentDir,
    authProfileStore: authorization.authProfileStore,
    options,
    taskLabel: "isolated completion",
    developerInstructions: params.systemPrompt,
    input: [{ type: "text", text: params.prompt, text_elements: [] }],
    requiredModalities: ["text"],
    isolation: "configured-transport",
    requireNoExternalCapabilities: true,
  });
  assertCodexPassiveTurnItems(result.items, params.prompt, "isolated completion");
  return {
    assistant: createAttributedCodexAssistantMessage(
      {
        api: "openai-chatgpt-responses",
        provider: params.provider,
        modelId: result.model,
      },
      result.text,
      { tokenUsage: result.usage, aborted: false, promptError: null },
    ),
  };
}
