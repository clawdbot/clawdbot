import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerPreparedAuthHandoff } from "./auth-bridge.js";
import { runBoundedCodexAppServerTurn, type CodexBoundedTurnOptions } from "./bounded-turn.js";
import { readCodexPluginConfig, resolveCodexAppServerHomeScope } from "./config.js";
import { createAttributedCodexAssistantMessage } from "./event-projector-assistant-message.js";
import { isJsonObject, type CodexThreadItem } from "./protocol.js";

const ISOLATED_PASSIVE_ITEM_TYPES = new Set(["agentMessage", "reasoning"]);

type CodexIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>
>[0];
type AgentHarnessIsolatedCompletionResult = Awaited<
  ReturnType<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>
>;

function assertIsolatedCompletionItems(items: CodexThreadItem[], prompt: string): void {
  let promptEchoSeen = false;
  for (const item of items) {
    if (ISOLATED_PASSIVE_ITEM_TYPES.has(item.type)) {
      continue;
    }
    if (item.type === "userMessage" && !promptEchoSeen) {
      const content = Array.isArray(item.content) ? item.content : [];
      const input = content[0];
      if (
        content.length === 1 &&
        isJsonObject(input) &&
        input.type === "text" &&
        input.text === prompt
      ) {
        promptEchoSeen = true;
        continue;
      }
    }
    throw new Error(`Codex isolated completion returned unexpected native item: ${item.type}`);
  }
}

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
  assertIsolatedCompletionItems(result.items, params.prompt);
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
