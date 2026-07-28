import type { LlmRuntime } from "@openclaw/ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveProviderTextTransforms } from "../../plugins/provider-runtime.js";
import { wrapStreamFnTextTransforms } from "../plugin-text-transforms.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import {
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "./stream-resolution.js";
import { mapThinkingLevelForProvider } from "./utils.js";

export async function prepareCompactionSessionAgent(params: {
  session: { agent: { streamFn?: unknown } };
  llmRuntime: LlmRuntime;
  providerStreamFn: unknown;
  sessionId: string;
  signal: AbortSignal;
  effectiveModel: ProviderRuntimeModel;
  resolvedApiKey?: string;
  authStorage: unknown;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  thinkLevel: ThinkLevel;
  sessionAgentId: string;
  effectiveWorkspace: string;
  agentDir: string;
  runtimePlan?: AgentRuntimePlan;
  sessionKey?: string;
  sandboxToolPolicy?: { allow?: string[]; deny?: string[] };
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}) {
  const authStorage =
    params.authStorage &&
    typeof params.authStorage === "object" &&
    "getApiKey" in params.authStorage &&
    typeof params.authStorage.getApiKey === "function"
      ? (params.authStorage as {
          getApiKey(provider: string): Promise<string | undefined>;
        })
      : undefined;
  const transportApiKey = authStorage
    ? await resolveEmbeddedAgentApiKey({
        provider: params.effectiveModel.provider,
        resolvedApiKey: params.resolvedApiKey,
        authStorage,
      })
    : params.resolvedApiKey;
  params.session.agent.streamFn = resolveEmbeddedAgentStreamFn({
    llmRuntime: params.llmRuntime,
    currentStreamFn: resolveEmbeddedAgentBaseStreamFn({ session: params.session as never }),
    providerStreamFn: params.providerStreamFn as never,
    sessionId: params.sessionId,
    signal: params.signal,
    model: params.effectiveModel,
    resolvedApiKey: params.resolvedApiKey,
    transportAuthAvailable: Boolean(transportApiKey?.trim()),
    authProfileId: params.runtimePlan?.auth.forwardedAuthProfileId,
    authStorage: params.authStorage as never,
  });
  const providerTextTransforms = resolveProviderTextTransforms({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.effectiveWorkspace,
  });
  if (providerTextTransforms) {
    params.session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: params.session.agent.streamFn as never,
      input: providerTextTransforms.input,
      output: providerTextTransforms.output,
      transformSystemPrompt: false,
    }) as never;
  }
  const providerThinkingLevel = mapThinkingLevelForProvider(params.thinkLevel);
  const preparedRuntimeExtraParams = params.runtimePlan?.transport.resolveExtraParams({
    thinkingLevel: providerThinkingLevel,
    agentId: params.sessionAgentId,
    workspaceDir: params.effectiveWorkspace,
    model: params.effectiveModel,
  });
  return applyExtraParamsToAgent(
    params.session.agent as never,
    params.config,
    params.provider,
    params.modelId,
    undefined,
    providerThinkingLevel,
    params.sessionAgentId,
    params.effectiveWorkspace,
    params.effectiveModel,
    params.agentDir,
    undefined,
    {
      ...(preparedRuntimeExtraParams ? { preparedExtraParams: preparedRuntimeExtraParams } : {}),
      nativeWebSearchPolicyContext: {
        // Compaction rebuilds the stream wrapper, so preserve the session policy
        // inputs that can suppress provider-native search.
        sessionKey: params.sessionKey,
        sandboxToolPolicy: params.sandboxToolPolicy,
        messageProvider: params.messageProvider,
        agentAccountId: params.agentAccountId,
        groupId: params.groupId,
        groupChannel: params.groupChannel,
        groupSpace: params.groupSpace,
        spawnedBy: params.spawnedBy,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164,
      },
    },
  );
}
