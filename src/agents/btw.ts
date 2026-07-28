import { randomUUID } from "node:crypto";
/**
 * Runs `/btw` side questions against the active conversation without resuming
 * or continuing the main task.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import type { ChatType } from "../channels/chat-type.js";
import type { SessionEntry as StoredSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamWithPayloadPatch } from "../llm/providers/stream-wrappers/stream-payload-utils.js";
import type {
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  TextContent,
} from "../llm/types.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveSessionAgentId,
} from "./agent-scope.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "./auth-profiles/external-cli-auth-selection.js";
import { resolveSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { readBtwTranscriptMessages, resolveBtwSessionTranscriptPath } from "./btw-transcript.js";
import { executePreparedCliRun } from "./cli-runner/execute.runtime.js";
import { prepareCliRunContext } from "./cli-runner/prepare.runtime.js";
import { EmbeddedBlockChunker, type BlockReplyChunking } from "./embedded-agent-block-chunker.js";
import { resolveModelAsync, resolveModelWithRegistry } from "./embedded-agent-runner/model.js";
import { getActiveEmbeddedRunSnapshot } from "./embedded-agent-runner/runs.js";
import { resolveEmbeddedAgentStreamFn } from "./embedded-agent-runner/stream-resolution.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import {
  resolveAvailableAgentHarnessPolicy,
  resolvePluginHarnessPolicyToolsAllow,
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
  type AgentHarnessPreparedModelProvider,
} from "./harness/selection.js";
import {
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "./harness/support.js";
import type { AgentHarness } from "./harness/types.js";
import {
  resolveImageSanitizationLimits,
  type ImageSanitizationLimits,
} from "./image-sanitization.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  applySecretRefHeaderSentinels,
  requireApiKey,
} from "./model-auth.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import {
  isOpenAIProvider,
  listOpenAIAuthProfileProvidersForAgentRuntime,
} from "./openai-routing.js";
import {
  loadPreparedModelRuntimeSnapshot,
  preparedModelRuntimeConfigsMatch,
  type PreparedModelRuntimeSnapshot,
  type PreparedModelRuntimeStores,
} from "./prepared-model-runtime.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
  scopeAuthProfileStoreToPreparedPlan,
} from "./runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";
import { resolveSessionModelRef } from "./session-model-ref.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";
import { getModelRegistryRuntime } from "./sessions/model-registry-runtime.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { sanitizeImageBlocks } from "./tool-images.js";

function collectTextContent(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function collectThinkingContent(content: Array<{ type?: string; thinking?: string }>): string {
  return content
    .filter((part): part is { type: "thinking"; thinking: string } => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}

function buildBtwSystemPrompt(): string {
  return [
    "You are answering an ephemeral /btw side question about the current conversation.",
    "Use the conversation only as background context.",
    "Answer only the side question in the last user message.",
    "Do not continue, resume, or complete any unfinished task from the conversation.",
    "Do not emit tool calls, pseudo-tool calls, shell commands, file writes, patches, or code unless the side question explicitly asks for them.",
    "Do not say you will continue the main task after answering.",
    "If the question can be answered briefly, answer briefly.",
  ].join("\n");
}

function resolveReturnedAuthProfileSource(
  sessionEntry: StoredSessionEntry | undefined,
  authProfileId: string | undefined,
): "auto" | "user" | undefined {
  if (!authProfileId?.trim()) {
    return undefined;
  }
  if (sessionEntry?.authProfileOverride?.trim() !== authProfileId) {
    return "auto";
  }
  return (
    sessionEntry.authProfileOverrideSource ??
    (typeof sessionEntry.authProfileOverrideCompactionCount === "number" ? "auto" : "user")
  );
}

// Planning and immediate resolution share one scoped snapshot so provider
// bindings and cooldown decisions cannot diverge inside a side question.
function resolveBtwAuthProfileStore(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): {
  store: AuthProfileStore;
  ignoreAutoPreferredProfile: boolean;
} {
  if (isOpenAIProvider(params.provider)) {
    return {
      store: ensureAuthProfileStore(params.agentDir, {
        externalCliProviderIds: ["openai"],
        allowKeychainPrompt: false,
      }),
      ignoreAutoPreferredProfile: false,
    };
  }

  const userLockedAuthProfileId =
    params.authProfileIdSource === "user" ? params.authProfileId : undefined;
  let externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
    provider: params.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: params.modelId,
    workspaceDir: params.workspaceDir,
    userLockedAuthProfileId,
  });
  let store: AuthProfileStore;
  if (externalCliAuthScope.providerIds) {
    store = ensureAuthProfileStore(params.agentDir, {
      externalCliProviderIds: externalCliAuthScope.providerIds,
      allowKeychainPrompt: false,
    });
  } else {
    store = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      allowKeychainPrompt: false,
    });
    externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
      provider: params.provider,
      cfg: params.cfg,
      agentId: params.agentId,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      store,
      userLockedAuthProfileId,
    });
    if (externalCliAuthScope.providerIds) {
      store = ensureAuthProfileStore(params.agentDir, {
        externalCliProviderIds: externalCliAuthScope.providerIds,
        allowKeychainPrompt: false,
      });
    }
  }
  return {
    store,
    ignoreAutoPreferredProfile: externalCliAuthScope.ignoreAutoPreferredProfile,
  };
}

function buildBtwQuestionPrompt(question: string, inFlightPrompt?: string): string {
  const lines = [
    "Answer this side question only.",
    "Ignore any unfinished task in the conversation while answering it.",
  ];
  const trimmedPrompt = inFlightPrompt?.trim();
  if (trimmedPrompt) {
    lines.push(
      "",
      "Current in-flight main task request for background context only:",
      "<in_flight_main_task>",
      trimmedPrompt,
      "</in_flight_main_task>",
      "Do not continue or complete that task while answering the side question.",
    );
  }
  lines.push("", "<btw_side_question>", question.trim(), "</btw_side_question>");
  return lines.join("\n");
}

function collectBtwMessageText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "image") {
        return "[Image content omitted from CLI side-question context.]";
      }
      return [];
    })
    .join("\n")
    .trim();
}

function buildBtwCliPrompt(params: {
  messages: Message[];
  question: string;
  inFlightPrompt?: string;
}): string {
  const lines = [
    "Use this sanitized conversation history as background context only.",
    "Do not continue, resume, or complete any unfinished task from the conversation.",
    "",
    "<conversation_history>",
  ];
  for (const message of params.messages) {
    const text = collectBtwMessageText(message.content);
    if (!text) {
      continue;
    }
    lines.push(`${message.role === "assistant" ? "Assistant" : "User"}:`, text, "");
  }
  lines.push("</conversation_history>", "");
  lines.push(buildBtwQuestionPrompt(params.question, params.inFlightPrompt));
  return lines.join("\n");
}

function normalizeBtwContentBlocks(content: unknown): unknown[] | undefined {
  if (Array.isArray(content)) {
    return content;
  }
  if (content && typeof content === "object") {
    return [content];
  }
  return undefined;
}

function isBtwTextBlock(block: unknown): block is TextContent {
  if (!block || typeof block !== "object") {
    return false;
  }
  const record = block as { type?: unknown; text?: unknown };
  return normalizeLowercaseStringOrEmpty(record.type) === "text" && typeof record.text === "string";
}

function isBtwImageBlock(block: unknown): block is ImageContent {
  if (!block || typeof block !== "object") {
    return false;
  }
  const record = block as { type?: unknown; data?: unknown; mimeType?: unknown };
  return (
    normalizeLowercaseStringOrEmpty(record.type) === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  );
}

async function sanitizeBtwUserMessage(params: {
  message: Extract<Message, { role: "user" }>;
  imageLimits: ImageSanitizationLimits;
}): Promise<Extract<Message, { role: "user" }> | undefined> {
  if (typeof params.message.content === "string") {
    return params.message;
  }
  const blocks = normalizeBtwContentBlocks(params.message.content);
  if (!blocks) {
    return undefined;
  }

  const content: Array<TextContent | ImageContent> = [];
  for (const block of blocks) {
    if (isBtwTextBlock(block)) {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (!isBtwImageBlock(block)) {
      continue;
    }
    const { images } = await sanitizeImageBlocks([block], "btw:context", params.imageLimits);
    const image = images[0];
    if (image) {
      content.push(image);
    }
  }

  if (content.length === 0) {
    return undefined;
  }
  return {
    ...params.message,
    content,
  };
}

function sanitizeBtwAssistantMessage(
  message: Extract<Message, { role: "assistant" }>,
): Extract<Message, { role: "assistant" }> | undefined {
  const rawContent = (message as { content?: unknown }).content;
  if (typeof rawContent === "string") {
    const trimmed = rawContent.trim();
    return trimmed.length > 0
      ? {
          ...message,
          content: [{ type: "text", text: trimmed }],
        }
      : undefined;
  }
  const blocks = normalizeBtwContentBlocks(rawContent);
  if (!blocks) {
    return undefined;
  }
  const content = blocks.flatMap((block): TextContent[] =>
    isBtwTextBlock(block) ? [{ type: "text", text: block.text }] : [],
  );
  if (content.length === 0) {
    return undefined;
  }
  return {
    ...message,
    content,
  };
}

async function toSimpleContextMessages(params: {
  messages: unknown[];
  imageLimits: ImageSanitizationLimits;
}): Promise<Message[]> {
  const contextMessages: Message[] = [];
  for (const message of params.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role === "user") {
      const sanitizedMessage = await sanitizeBtwUserMessage({
        message: message as Extract<Message, { role: "user" }>,
        imageLimits: params.imageLimits,
      });
      if (sanitizedMessage) {
        contextMessages.push(sanitizedMessage);
      }
      continue;
    }
    if (role !== "assistant") {
      continue;
    }
    // BTW is a no-tools path, so keep only user-visible blocks from prior
    // messages and strip hidden reasoning/tool replay data.
    const sanitizedMessage = sanitizeBtwAssistantMessage(
      message as Extract<Message, { role: "assistant" }>,
    );
    if (sanitizedMessage) {
      contextMessages.push(sanitizedMessage);
    }
  }
  return stripToolResultDetails(
    contextMessages as Parameters<typeof stripToolResultDetails>[0],
  ) as Message[];
}

type BtwRuntimeAuthPreparation = ReturnType<typeof prepareAgentRuntimeAuth>;

type BtwRuntimeModelMaterialization = {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  agentDir: string;
  workspaceDir?: string;
  authStorage: PreparedModelRuntimeStores["authStorage"];
  modelRegistry: PreparedModelRuntimeStores["modelRegistry"];
};

async function materializeBtwRuntimeModel(
  params: BtwRuntimeModelMaterialization & {
    plan: AgentRuntimeAuthPlan;
    model: Model;
    forceResolve?: boolean;
  },
): Promise<Model> {
  return (
    (await materializePreparedRuntimeModel({
      plan: params.plan,
      provider: params.provider,
      modelId: params.modelId,
      config: params.cfg,
      model: params.model,
      ...(params.forceResolve !== undefined ? { forceResolve: params.forceResolve } : {}),
      resolveModel: ({ config, authProfileId, authProfileMode }) =>
        resolveModelAsync(params.provider, params.modelId, params.agentDir, config, {
          authStorage: params.authStorage,
          modelRegistry: params.modelRegistry,
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: true,
          preferBundledStaticCatalogTransport: true,
          workspaceDir: params.workspaceDir,
          authProfileId,
          authProfileMode,
        }),
    })) ?? params.model
  );
}

async function resolveBtwPreparedRuntimeAuth(
  params: BtwRuntimeModelMaterialization & {
    preparation: BtwRuntimeAuthPreparation;
    model: Model;
    authProfileStore: AuthProfileStore;
  },
) {
  return resolvePreparedRuntimeAuthAttempts({
    attempts: params.preparation.attempts,
    store: params.authProfileStore,
    modelId: params.modelId,
    model: params.model,
    materializeModel: ({ plan, model, forceResolve }) =>
      materializeBtwRuntimeModel({ ...params, plan, model, forceResolve }),
    resolveAuth: async ({ attempt, model }) =>
      await resolvePreparedRuntimeModelAuth({
        plan: attempt.plan,
        model,
        cfg: params.cfg,
        store: params.authProfileStore,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        ...(attempt.allowAuthProfileFallback !== undefined
          ? { allowAuthProfileFallback: attempt.allowAuthProfileFallback }
          : {}),
        secretSentinels: true,
      }),
    errorMessage: "BTW prepared auth attempts could not be resolved.",
  });
}

async function resolveRuntimeModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  sessionEntry?: StoredSessionEntry;
  sessionStore?: Record<string, StoredSessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
  harnessId?: string;
  harnessAuthBootstrap?: AgentHarness["authBootstrap"];
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
}): Promise<{
  model: Model;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileStore: AuthProfileStore;
  runtimeAuthPreparation: BtwRuntimeAuthPreparation;
  authStorage: PreparedModelRuntimeStores["authStorage"];
  modelRegistry: PreparedModelRuntimeStores["modelRegistry"];
}> {
  const preparedModelRuntime = params.preparedModelRuntime;
  const cfg = preparedModelRuntime.config;
  const agentDir = preparedModelRuntime.agentDir;
  const workspaceDir = preparedModelRuntime.workspaceDir;
  const { authStorage, modelRegistry } = preparedModelRuntime.createStores();
  let model = resolveModelWithRegistry({
    provider: params.provider,
    modelId: params.model,
    modelRegistry,
    cfg,
  });
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.model}`);
  }
  const runtimeProvider = model.provider;
  const runtimeModelId = model.id;

  const acceptedProviderIds = listOpenAIAuthProfileProvidersForAgentRuntime({
    provider: runtimeProvider,
    harnessRuntime: params.harnessId,
    agentHarnessId: params.harnessId,
    config: cfg,
  });
  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg,
    provider: runtimeProvider,
    acceptedProviderIds,
    agentDir,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    isNewSession: params.isNewSession,
  });
  const authProfileIdSource = resolveReturnedAuthProfileSource(params.sessionEntry, authProfileId);
  const authProfileStoreSelection = resolveBtwAuthProfileStore({
    cfg,
    provider: runtimeProvider,
    modelId: runtimeModelId,
    agentId: params.agentId,
    agentDir,
    workspaceDir,
    authProfileId,
    authProfileIdSource,
  });
  const effectiveAuthProfileId =
    authProfileStoreSelection.ignoreAutoPreferredProfile && authProfileIdSource !== "user"
      ? undefined
      : authProfileId;
  const runtimeAuthPreparation = prepareAgentRuntimeAuth({
    provider: runtimeProvider,
    modelId: runtimeModelId,
    modelApi: model.api,
    modelBaseUrl: model.baseUrl,
    config: cfg,
    env: process.env,
    workspaceDir,
    authProfileStore: authProfileStoreSelection.store,
    sessionAuthProfileId: effectiveAuthProfileId,
    sessionAuthProfileSource: authProfileIdSource,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessId,
    harnessAuthBootstrap: params.harnessAuthBootstrap,
  });
  model = await materializeBtwRuntimeModel({
    cfg,
    provider: runtimeProvider,
    modelId: runtimeModelId,
    agentDir,
    workspaceDir,
    authStorage,
    modelRegistry,
    plan: runtimeAuthPreparation.plan,
    model,
  });
  return {
    model,
    authProfileId: runtimeAuthPreparation.plan.forwardedAuthProfileId,
    authProfileIdSource: runtimeAuthPreparation.plan.forwardedAuthProfileSource,
    authProfileStore: authProfileStoreSelection.store,
    runtimeAuthPreparation,
    authStorage,
    modelRegistry,
  };
}

type RunBtwSideQuestionParams = {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: string;
  model: string;
  question: string;
  sessionEntry: StoredSessionEntry;
  sessionStore?: Record<string, StoredSessionEntry>;
  sessionKey?: string;
  sandboxSessionKey?: string;
  storePath?: string;
  resolvedThinkLevel?: ThinkLevel;
  resolvedReasoningLevel: ReasoningLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  opts?: GetReplyOptions;
  isNewSession: boolean;
  messageChannel?: string;
  messageProvider?: string;
  chatType?: ChatType;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  chatId?: string;
  messageActionTurnCapability?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  memberRoleIds?: string[];
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  senderIsOwner?: boolean;
  currentChannelId?: string;
};

async function runCliBtwSideQuestion(params: {
  cfg: OpenClawConfig;
  model: string;
  question: string;
  sessionId: string;
  sessionFile: string;
  sessionEntry: StoredSessionEntry;
  sessionKey?: string;
  sessionAgentId: string;
  workspaceDir: string;
  cliProvider: string;
  authProfileId?: string;
  resolvedThinkLevel?: ThinkLevel;
  messages: Message[];
  inFlightPrompt?: string;
  opts?: GetReplyOptions;
  messageChannel?: string;
  messageProvider?: string;
  currentChannelId?: string;
}): Promise<ReplyPayload> {
  const timeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfg,
    overrideSeconds: params.opts?.timeoutOverrideSeconds,
  });
  const prepared = await prepareCliRunContext({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    agentId: params.sessionAgentId,
    trigger: "user",
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    prompt: buildBtwCliPrompt({
      messages: params.messages,
      question: params.question,
      inFlightPrompt: params.inFlightPrompt,
    }),
    extraSystemPrompt: buildBtwSystemPrompt(),
    executionMode: "side-question",
    provider: params.cliProvider,
    model: params.model,
    thinkLevel: params.resolvedThinkLevel,
    disableTools: true,
    timeoutMs,
    runTimeoutOverrideMs: timeoutMs,
    runId: params.opts?.runId ?? `btw-${randomUUID()}`,
    authProfileId: params.authProfileId,
    abortSignal: params.opts?.abortSignal,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    currentChannelId: params.currentChannelId,
  });
  try {
    const output = await executePreparedCliRun(prepared);
    const text = output.text.trim();
    if (!text) {
      throw new Error(`/btw side question via ${params.cliProvider} produced no answer.`);
    }
    return { text };
  } finally {
    await prepared.preparedBackend.cleanup?.();
  }
}

/** Answers a side question using sanitized session context and no tool execution. */
export async function runBtwSideQuestion(
  paramsInput: RunBtwSideQuestionParams,
): Promise<ReplyPayload | undefined> {
  let params = paramsInput;
  const sessionId = params.sessionEntry.sessionId?.trim();
  if (!sessionId) {
    throw new Error("No active session context.");
  }

  const sessionFile = resolveBtwSessionTranscriptPath({
    sessionId,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!sessionFile) {
    throw new Error("No active session transcript.");
  }

  const requestedAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const requestedWorkspaceDir = resolveAgentWorkspaceDir(params.cfg, requestedAgentId);
  const preparedModelRuntime = await loadPreparedModelRuntimeSnapshot({
    config: params.cfg,
    agentId: requestedAgentId,
    agentDir: params.agentDir,
    inheritedAuthDir: resolveDefaultAgentDir(params.cfg),
    workspaceDir: requestedWorkspaceDir,
  });
  const sessionAgentId =
    preparedModelRuntime.agentId ??
    resolveSessionAgentId({ sessionKey: params.sessionKey, config: preparedModelRuntime.config });
  const workspaceDir =
    preparedModelRuntime.workspaceDir ??
    resolveAgentWorkspaceDir(preparedModelRuntime.config, sessionAgentId);
  const preparedModelRef = preparedModelRuntimeConfigsMatch(preparedModelRuntime.config, params.cfg)
    ? { provider: params.provider, model: params.model }
    : resolveSessionModelRef(preparedModelRuntime.config, params.sessionEntry, sessionAgentId);
  // BTW policy, model selection, directories, auth, and catalog must come from one generation.
  // A reload may have committed while the command waited for its transcript/session lookup.
  // Rebind every later policy/auth/dispatch read to the generation returned above.
  params = {
    ...params,
    cfg: preparedModelRuntime.config,
    agentDir: preparedModelRuntime.agentDir,
    provider: preparedModelRef.provider,
    model: preparedModelRef.model,
  };
  const preparedHarnesses = new Map<string, AgentHarness>();
  const prepareHarness = async (
    provider: string,
    modelId: string,
    modelProvider?: AgentHarnessPreparedModelProvider,
  ): Promise<AgentHarness> => {
    const agentHarnessId = isModelSelectionLocked(params.sessionEntry)
      ? params.sessionEntry.agentHarnessId
      : undefined;
    const agentHarnessRuntimeOverride = agentHarnessId
      ? undefined
      : resolveSessionRuntimeOverrideForProvider({
          provider,
          entry: params.sessionEntry,
          cfg: params.cfg,
        });
    const selectedHarnessId = agentHarnessId ?? agentHarnessRuntimeOverride ?? "configured";
    const key = [
      `${provider}/${modelId}/${selectedHarnessId}`,
      modelProvider?.api ?? "",
      modelProvider?.baseUrl ?? "",
      modelProvider?.requestTransportOverrides ?? "",
      modelProvider?.runtimePolicy?.compatibleIds.join(",") ?? "",
      modelProvider?.preparedAuth?.source ?? "",
      modelProvider?.preparedAuth?.mode ?? "",
      modelProvider?.preparedAuth?.requirement ?? "",
    ].join("\0");
    const cached = preparedHarnesses.get(key);
    if (cached) {
      return cached;
    }
    await ensureSelectedAgentHarnessPlugin({
      provider,
      modelId,
      config: params.cfg,
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      workspaceDir,
      ...(agentHarnessId ? { agentHarnessId } : {}),
      ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
    });
    const selectionParams = {
      provider,
      modelId,
      config: params.cfg,
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      ...(agentHarnessId ? { agentHarnessId } : {}),
      ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
    };
    const harness = modelProvider
      ? selectAgentHarnessForPreparedModelProviders({
          ...selectionParams,
          modelProviders: [modelProvider],
        })
      : selectAgentHarness(selectionParams);
    preparedHarnesses.set(key, harness);
    return harness;
  };
  const harness = await prepareHarness(params.provider, params.model);
  let runtimeSelection: Awaited<ReturnType<typeof resolveRuntimeModel>> | undefined;
  const resolveRuntimeSelection = async () => {
    if (!runtimeSelection) {
      runtimeSelection = await resolveRuntimeModel({
        cfg: params.cfg,
        provider: params.provider,
        model: params.model,
        agentId: sessionAgentId,
        agentDir: params.agentDir,
        workspaceDir,
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        isNewSession: params.isNewSession,
        harnessId: harness.id,
        harnessAuthBootstrap: harness.authBootstrap,
        preparedModelRuntime,
      });
    }
    return runtimeSelection;
  };
  type BtwHarnessSideQuestionDispatch =
    | { kind: "handled"; payload: ReplyPayload }
    | {
        kind: "openclaw";
        harness: AgentHarness;
        runtime: Awaited<ReturnType<typeof resolveRuntimeModel>>;
        resolvedAttempt: Awaited<ReturnType<typeof resolveBtwPreparedRuntimeAuth>>;
      };
  let preparedOpenClawFallback:
    | Extract<BtwHarnessSideQuestionDispatch, { kind: "openclaw" }>
    | undefined;
  const runHarnessSideQuestion = async (
    selectedHarness: AgentHarness,
    runtime: Awaited<ReturnType<typeof resolveRuntimeModel>>,
    routeFinalized = false,
  ): Promise<BtwHarnessSideQuestionDispatch> => {
    const toolsAllow = resolvePluginHarnessPolicyToolsAllow({
      config: params.cfg,
      sessionKey: params.sessionKey,
      sandboxSessionKey: params.sandboxSessionKey,
      agentId: sessionAgentId,
      provider: runtime.model.provider,
      modelId: runtime.model.id,
      messageProvider: params.messageProvider,
      messageChannel: params.messageChannel,
      spawnedBy: params.spawnedBy,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      agentAccountId: params.agentAccountId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    const authProfileStoreSelection =
      selectedHarness.id === harness.id
        ? undefined
        : resolveBtwAuthProfileStore({
            cfg: params.cfg,
            provider: runtime.model.provider,
            modelId: runtime.model.id,
            agentId: sessionAgentId,
            agentDir: params.agentDir,
            workspaceDir,
            authProfileId: runtime.authProfileId,
            authProfileIdSource: runtime.authProfileIdSource,
          });
    const runtimeAuthPreparation = authProfileStoreSelection
      ? prepareAgentRuntimeAuth({
          provider: runtime.model.provider,
          modelId: runtime.model.id,
          modelApi: runtime.model.api,
          modelBaseUrl: runtime.model.baseUrl,
          config: params.cfg,
          env: process.env,
          workspaceDir,
          authProfileStore: authProfileStoreSelection.store,
          sessionAuthProfileId:
            authProfileStoreSelection.ignoreAutoPreferredProfile &&
            runtime.authProfileIdSource !== "user"
              ? undefined
              : runtime.authProfileId,
          sessionAuthProfileSource: runtime.authProfileIdSource,
          harnessId: selectedHarness.id,
          harnessRuntime: selectedHarness.id,
          harnessAuthBootstrap: selectedHarness.authBootstrap,
        })
      : runtime.runtimeAuthPreparation;
    const selectedAuthProfileStore = authProfileStoreSelection?.store ?? runtime.authProfileStore;
    const implicitHarnessAuthPlan =
      selectedHarness.authBootstrap === "harness" &&
      runtimeAuthPreparation.attempts.length === 1 &&
      runtimeAuthPreparation.attempts[0]?.kind === "implicit" &&
      runtimeAuthPreparation.attempts[0].plan.harnessAuthProvider
        ? runtimeAuthPreparation.attempts[0].plan
        : undefined;
    // A native harness owns this deferred auth decision. Resolving it through
    // OpenClaw would incorrectly require a host credential before handoff.
    const resolvedAttempt = implicitHarnessAuthPlan
      ? { plan: implicitHarnessAuthPlan, model: runtime.model }
      : await resolveBtwPreparedRuntimeAuth({
          preparation: runtimeAuthPreparation,
          model: runtime.model,
          cfg: params.cfg,
          provider: runtime.model.provider,
          modelId: runtime.model.id,
          agentDir: params.agentDir,
          workspaceDir,
          authStorage: runtime.authStorage,
          modelRegistry: runtime.modelRegistry,
          authProfileStore: selectedAuthProfileStore,
        });
    const runtimeAuthPlan = resolvedAttempt.plan;
    const runtimeModel = resolvedAttempt.model;
    const finalizedHarness = await prepareHarness(runtimeModel.provider, runtimeModel.id, {
      api: runtimeModel.api,
      baseUrl: runtimeModel.baseUrl,
      ...resolveAgentHarnessPreparedRouteSupport(runtimeAuthPlan),
      preparedAuth: resolveAgentHarnessPreparedAuthSupport({ plan: runtimeAuthPlan }),
    });
    if (finalizedHarness.id !== selectedHarness.id) {
      if (routeFinalized) {
        throw new Error("Agent harness selection changed after route materialization.");
      }
      return runHarnessSideQuestion(
        finalizedHarness,
        {
          ...runtime,
          model: runtimeModel,
          runtimeAuthPreparation,
          authProfileStore: selectedAuthProfileStore,
        },
        true,
      );
    }
    if (!selectedHarness.runSideQuestion) {
      if (selectedHarness.id !== "openclaw" || !("auth" in resolvedAttempt)) {
        throw new Error(
          `Selected agent harness "${selectedHarness.id}" does not support /btw side questions.`,
        );
      }
      return {
        kind: "openclaw",
        harness: selectedHarness,
        runtime: {
          ...runtime,
          model: runtimeModel,
          authProfileId: runtimeAuthPlan.forwardedAuthProfileId,
          authProfileIdSource: runtimeAuthPlan.forwardedAuthProfileSource,
          authProfileStore: selectedAuthProfileStore,
          runtimeAuthPreparation,
        },
        resolvedAttempt,
      };
    }
    const resolvedApiKey =
      runtimeAuthPlan.modelRoute?.authRequirement === "api-key" && "auth" in resolvedAttempt
        ? resolvedAttempt.auth.apiKey?.trim()
        : undefined;
    const result = await selectedHarness.runSideQuestion({
      ...params,
      provider: runtimeModel.provider,
      model: runtimeModel.id,
      runtimeModel,
      preparedRuntimeAuth: {
        plan: runtimeAuthPlan,
        authProfileStore: scopeAuthProfileStoreToPreparedPlan(
          selectedAuthProfileStore,
          runtimeAuthPlan,
        ),
        authStorage: runtime.authStorage,
        modelRegistry: runtime.modelRegistry,
        ...(resolvedApiKey
          ? {
              resolvedApiKey: unwrapSecretSentinelsForProviderEgress(
                resolvedApiKey,
                "BTW harness handoff",
              ),
            }
          : {}),
      },
      sessionId,
      sessionFile,
      agentId: sessionAgentId,
      workspaceDir,
      ...(toolsAllow ? { toolsAllow } : {}),
      authProfileId:
        runtimeAuthPlan.modelRoute?.authRequirement === "api-key"
          ? undefined
          : runtimeAuthPlan.forwardedAuthProfileId,
      authProfileIdSource:
        runtimeAuthPlan.modelRoute?.authRequirement === "api-key"
          ? undefined
          : runtimeAuthPlan.forwardedAuthProfileSource,
    });
    return { kind: "handled", payload: { text: result.text } };
  };
  if (harness.runSideQuestion) {
    const dispatch = await runHarnessSideQuestion(harness, await resolveRuntimeSelection());
    if (dispatch.kind === "handled") {
      return dispatch.payload;
    }
    preparedOpenClawFallback = dispatch;
  }
  if (harness.id === "codex" && !harness.runSideQuestion) {
    throw new Error(`Selected agent harness "${harness.id}" does not support /btw side questions.`);
  }

  const activeRunSnapshot = getActiveEmbeddedRunSnapshot(sessionId);
  const imageLimits = resolveImageSanitizationLimits(params.cfg);
  let messages: Message[] = [];
  let inFlightPrompt: string | undefined;
  if (Array.isArray(activeRunSnapshot?.messages) && activeRunSnapshot.messages.length > 0) {
    messages = await toSimpleContextMessages({
      messages: activeRunSnapshot.messages,
      imageLimits,
    });
    inFlightPrompt = activeRunSnapshot.inFlightPrompt;
  } else if (activeRunSnapshot) {
    inFlightPrompt = activeRunSnapshot.inFlightPrompt;
  }
  if (messages.length === 0) {
    messages = await toSimpleContextMessages({
      messages: await readBtwTranscriptMessages({
        sessionFile,
        sessionId,
        sessionKey: params.sessionKey,
        snapshotLeafId: activeRunSnapshot?.transcriptLeafId,
      }),
      imageLimits,
    });
  }
  if (messages.length === 0 && !inFlightPrompt?.trim()) {
    throw new Error("No active session context.");
  }

  const fallbackPolicy = resolveAvailableAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.model,
    config: params.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
  });
  const fallbackRuntime = fallbackPolicy.runtime.trim();
  const sessionAuthProfileId = params.sessionEntry.authProfileOverride?.trim() || undefined;
  const sessionAuthProfileSource = resolveReturnedAuthProfileSource(
    params.sessionEntry,
    sessionAuthProfileId,
  );
  const cliProviderFromSessionAuth = sessionAuthProfileId
    ? resolveCliRuntimeExecutionProvider({
        provider: params.provider,
        cfg: params.cfg,
        agentId: sessionAgentId,
        modelId: params.model,
        authProfileId: sessionAuthProfileId,
      })?.trim()
    : undefined;
  const cliProviderFromAuthOrder =
    !sessionAuthProfileId || sessionAuthProfileSource === "auto"
      ? resolveCliRuntimeExecutionProvider({
          provider: params.provider,
          cfg: params.cfg,
          agentId: sessionAgentId,
          modelId: params.model,
        })?.trim()
      : undefined;
  const resolvedCliProvider = cliProviderFromSessionAuth ?? cliProviderFromAuthOrder;
  const cliProvider =
    resolvedCliProvider ??
    (isCliRuntimeAliasForProvider({
      runtime: fallbackRuntime,
      provider: params.provider,
      cfg: params.cfg,
    })
      ? fallbackRuntime
      : undefined);
  if (cliProvider) {
    return runCliBtwSideQuestion({
      cfg: params.cfg,
      model: params.model,
      question: params.question,
      sessionId,
      sessionFile,
      sessionEntry: params.sessionEntry,
      sessionKey: params.sessionKey,
      sessionAgentId,
      workspaceDir,
      cliProvider,
      authProfileId: cliProviderFromSessionAuth ? sessionAuthProfileId : undefined,
      resolvedThinkLevel: params.resolvedThinkLevel,
      messages,
      inFlightPrompt,
      opts: params.opts,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      currentChannelId: params.currentChannelId,
    });
  }

  const initialOpenClawFallback = preparedOpenClawFallback;
  const runtimeSelectionForHarness =
    initialOpenClawFallback?.runtime ?? (await resolveRuntimeSelection());
  // Model resolution can canonicalize a legacy provider alias, so reselect against the resolved
  // provider/model instead of reusing the raw route's selection.
  const runtimeHarness =
    initialOpenClawFallback?.harness ??
    (await prepareHarness(
      runtimeSelectionForHarness.model.provider,
      runtimeSelectionForHarness.model.id,
    ));
  if (runtimeHarness.runSideQuestion) {
    const dispatch = await runHarnessSideQuestion(runtimeHarness, runtimeSelectionForHarness);
    if (dispatch.kind === "handled") {
      return dispatch.payload;
    }
    preparedOpenClawFallback = dispatch;
  }
  if (runtimeHarness.id === "codex" && !runtimeHarness.runSideQuestion) {
    throw new Error(
      `Selected agent harness "${runtimeHarness.id}" does not support /btw side questions.`,
    );
  }

  const finalizedOpenClawFallback = preparedOpenClawFallback;
  const effectiveRuntimeSelection =
    finalizedOpenClawFallback?.runtime ?? runtimeSelectionForHarness;
  const { authStorage, model, modelRegistry, authProfileStore, runtimeAuthPreparation } =
    effectiveRuntimeSelection;
  const resolvedAttempt =
    finalizedOpenClawFallback?.resolvedAttempt ??
    (await resolveBtwPreparedRuntimeAuth({
      preparation: runtimeAuthPreparation,
      model,
      cfg: params.cfg,
      provider: model.provider,
      modelId: model.id,
      agentDir: params.agentDir,
      workspaceDir,
      authStorage,
      modelRegistry,
      authProfileStore,
    }));
  const apiKeyInfo = resolvedAttempt.auth;
  const resolvedRuntimeAuthPlan = resolvedAttempt.plan;
  const resolvedAuthProfileId = resolvedRuntimeAuthPlan.forwardedAuthProfileId;
  let runtimeModel = resolvedAttempt.model;
  let apiKey =
    apiKeyInfo.mode === "aws-sdk" && !apiKeyInfo.apiKey
      ? undefined
      : requireApiKey(apiKeyInfo, runtimeModel.provider);
  if (apiKey) {
    const preparedAuth = protectPreparedProviderRuntimeAuth({
      provider: runtimeModel.provider,
      preparedAuth: await prepareProviderRuntimeAuth({
        provider: runtimeModel.provider,
        config: params.cfg,
        workspaceDir,
        env: process.env,
        context: {
          config: params.cfg,
          agentDir: params.agentDir,
          workspaceDir,
          env: process.env,
          provider: runtimeModel.provider,
          modelId: runtimeModel.id,
          model: runtimeModel,
          apiKey: unwrapSecretSentinelsForProviderEgress(apiKey, "provider runtime auth exchange"),
          authMode: apiKeyInfo.mode,
          profileId: resolvedAuthProfileId,
        },
      }),
    });
    runtimeModel = applyPreparedRuntimeAuthToModel(runtimeModel, preparedAuth);
    if (preparedAuth?.apiKey) {
      apiKey = preparedAuth.apiKey;
    }
  }
  runtimeModel = applySecretRefHeaderSentinels(runtimeModel, params.cfg);
  const modelRegistryRuntime = getModelRegistryRuntime(modelRegistry);

  // Use the provider's own stream fn so providers like Ollama (which build
  // `/api/chat` or `/v1/chat/completions` paths based on api mode) construct
  // URLs correctly. Without this, streamSimple hits the provider's baseUrl
  // directly and 404s on endpoints like Ollama Cloud (#68336).
  const providerStreamFn = registerProviderStreamForModel({
    model: runtimeModel,
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir,
    env: process.env,
    apiRegistry: modelRegistryRuntime.apiRegistry,
  });
  const streamFn = resolveEmbeddedAgentStreamFn({
    llmRuntime: modelRegistryRuntime.llmRuntime,
    currentStreamFn: modelRegistryRuntime.llmRuntime.streamSimple,
    providerStreamFn,
    sessionId,
    signal: params.opts?.abortSignal,
    model: runtimeModel,
    resolvedApiKey: apiKey,
    authProfileId: resolvedAuthProfileId,
  });

  const chunker =
    params.opts?.onBlockReply && params.blockReplyChunking
      ? new EmbeddedBlockChunker(params.blockReplyChunking)
      : undefined;
  let emittedBlocks = 0;
  let blockEmitChain: Promise<void> = Promise.resolve();
  let answerText = "";
  let reasoningText = "";
  let assistantStarted = false;
  let sawTextEvent = false;

  const emitBlockChunk = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !params.opts?.onBlockReply) {
      return;
    }
    emittedBlocks += 1;
    blockEmitChain = blockEmitChain.then(async () => {
      await params.opts?.onBlockReply?.({
        text,
        btw: { question: params.question },
      });
    });
    await blockEmitChain;
  };

  const stream = await streamWithPayloadPatch(
    streamFn,
    runtimeModel,
    {
      systemPrompt: buildBtwSystemPrompt(),
      messages: [
        ...messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildBtwQuestionPrompt(params.question, inFlightPrompt),
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      // BTW is intentionally a lightweight side question path. Keep provider
      // reasoning off so we reliably receive answer text instead of thinking-only output.
      reasoning: undefined,
      signal: params.opts?.abortSignal,
    },
    (payloadObj) => {
      // BTW is intentionally tool-less. Some OpenAI-compatible providers reject
      // the empty tools arrays injected for generic tool-history replay.
      if (Array.isArray(payloadObj.tools) && payloadObj.tools.length === 0) {
        delete payloadObj.tools;
      }
    },
  );

  let finalEvent:
    | Extract<AssistantMessageEvent, { type: "done" }>
    | Extract<AssistantMessageEvent, { type: "error" }>
    | undefined;

  for await (const event of stream) {
    finalEvent = event.type === "done" || event.type === "error" ? event : finalEvent;

    if (!assistantStarted && (event.type === "text_start" || event.type === "start")) {
      assistantStarted = true;
      await params.opts?.onAssistantMessageStart?.();
    }

    if (event.type === "text_delta") {
      sawTextEvent = true;
      answerText += event.delta;
      chunker?.append(event.delta);
      if (chunker && params.resolvedBlockStreamingBreak === "text_end") {
        chunker.drain({ force: false, emit: (chunk) => void emitBlockChunk(chunk) });
      }
      continue;
    }

    if (event.type === "text_end" && chunker && params.resolvedBlockStreamingBreak === "text_end") {
      chunker.drain({ force: true, emit: (chunk) => void emitBlockChunk(chunk) });
      continue;
    }

    if (event.type === "thinking_delta") {
      reasoningText += event.delta;
      if (params.resolvedReasoningLevel !== "off") {
        await params.opts?.onReasoningStream?.({ text: reasoningText, isReasoning: true });
      }
      continue;
    }

    if (event.type === "thinking_end" && params.resolvedReasoningLevel !== "off") {
      await params.opts?.onReasoningEnd?.();
    }
  }

  if (chunker && params.resolvedBlockStreamingBreak !== "text_end" && chunker.hasBuffered()) {
    chunker.drain({ force: true, emit: (chunk) => void emitBlockChunk(chunk) });
  }
  await blockEmitChain;

  if (finalEvent?.type === "error") {
    const message = collectTextContent(finalEvent.error.content);
    throw new Error(message || finalEvent.error.errorMessage || "BTW failed.");
  }

  const finalMessage = finalEvent?.type === "done" ? finalEvent.message : undefined;
  if (finalMessage) {
    if (!sawTextEvent) {
      answerText = collectTextContent(finalMessage.content);
    }
    if (!reasoningText) {
      collectThinkingContent(finalMessage.content);
    }
  }

  const answer = answerText.trim();
  if (!answer) {
    throw new Error("No BTW response generated.");
  }

  if (emittedBlocks > 0) {
    return undefined;
  }

  return { text: answer };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
