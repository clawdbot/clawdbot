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
import { streamSimple } from "../llm/stream.js";
import type {
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  TextContent,
} from "../llm/types.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { discoverAuthStorage, discoverModels } from "./agent-model-discovery.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "./auth-profiles/external-cli-auth-selection.js";
import { resolveSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import { readBtwTranscriptMessages, resolveBtwSessionTranscriptPath } from "./btw-transcript.js";
import { executePreparedCliRun } from "./cli-runner/execute.runtime.js";
import { prepareCliRunContext } from "./cli-runner/prepare.runtime.js";
import { EmbeddedBlockChunker, type BlockReplyChunking } from "./embedded-agent-block-chunker.js";
import { resolveModelWithRegistry } from "./embedded-agent-runner/model.js";
import { getActiveEmbeddedRunSnapshot } from "./embedded-agent-runner/runs.js";
import { resolveEmbeddedAgentStreamFn } from "./embedded-agent-runner/stream-resolution.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import {
  resolveAvailableAgentHarnessPolicy,
  resolvePluginHarnessPolicyToolsAllow,
  selectAgentHarness,
} from "./harness/selection.js";
import type { AgentHarness } from "./harness/types.js";
import {
  resolveImageSanitizationLimits,
  type ImageSanitizationLimits,
} from "./image-sanitization.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  applySecretRefHeaderSentinels,
  getApiKeyForModel,
  requireApiKey,
} from "./model-auth.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "./openai-routing.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";
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
  return (
    sessionEntry?.authProfileOverrideSource ??
    (typeof sessionEntry?.authProfileOverrideCompactionCount === "number" ? "auto" : "user")
  );
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
}): Promise<{
  model: Model;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}> {
  const modelsOptions = params.workspaceDir ? { workspaceDir: params.workspaceDir } : undefined;
  await ensureOpenClawModelsJson(params.cfg, params.agentDir, modelsOptions);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir, modelsOptions);
  const model = resolveModelWithRegistry({
    provider: params.provider,
    modelId: params.model,
    modelRegistry,
    cfg: params.cfg,
  });
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.model}`);
  }
  const runtimeProvider = model.provider;
  const runtimeModelId = model.id;

  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg: params.cfg,
    provider: runtimeProvider,
    acceptedProviderIds: listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: runtimeProvider,
      harnessRuntime: resolveAvailableAgentHarnessPolicy({
        provider: runtimeProvider,
        modelId: runtimeModelId,
        config: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }).runtime,
      config: params.cfg,
    }),
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    isNewSession: params.isNewSession,
  });
  return {
    model,
    authProfileId,
    authProfileIdSource: resolveReturnedAuthProfileSource(params.sessionEntry, authProfileId),
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
  params: RunBtwSideQuestionParams,
): Promise<ReplyPayload | undefined> {
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

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, sessionAgentId);
  const preparedHarnesses = new Map<string, AgentHarness>();
  const prepareHarness = async (provider: string, modelId: string): Promise<AgentHarness> => {
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
    const key = `${provider}/${modelId}/${selectedHarnessId}`;
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
    const harness = selectAgentHarness({
      provider,
      modelId,
      config: params.cfg,
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      ...(agentHarnessId ? { agentHarnessId } : {}),
      ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
    });
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
      });
    }
    return runtimeSelection;
  };
  const runHarnessSideQuestion = async (
    selectedHarness: AgentHarness,
    runtime: Awaited<ReturnType<typeof resolveRuntimeModel>>,
  ): Promise<ReplyPayload | undefined> => {
    if (!selectedHarness.runSideQuestion) {
      throw new Error(
        `Selected agent harness "${selectedHarness.id}" does not support /btw side questions.`,
      );
    }
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
    const result = await selectedHarness.runSideQuestion({
      ...params,
      provider: runtime.model.provider,
      model: runtime.model.id,
      runtimeModel: runtime.model,
      sessionId,
      sessionFile,
      agentId: sessionAgentId,
      workspaceDir,
      ...(toolsAllow ? { toolsAllow } : {}),
      authProfileId: runtime.authProfileId,
      authProfileIdSource: runtime.authProfileIdSource,
    });
    return { text: result.text };
  };
  if (harness.runSideQuestion) {
    return runHarnessSideQuestion(harness, await resolveRuntimeSelection());
  }
  if (harness.id === "codex") {
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

  const runtimeSelectionForHarness = await resolveRuntimeSelection();
  // Model resolution can canonicalize a legacy provider alias, so reselect against the resolved
  // provider/model instead of reusing the raw route's selection.
  const runtimeHarness = await prepareHarness(
    runtimeSelectionForHarness.model.provider,
    runtimeSelectionForHarness.model.id,
  );
  if (runtimeHarness.runSideQuestion) {
    return runHarnessSideQuestion(runtimeHarness, runtimeSelectionForHarness);
  }
  if (runtimeHarness.id === "codex") {
    throw new Error(
      `Selected agent harness "${runtimeHarness.id}" does not support /btw side questions.`,
    );
  }

  const { model, authProfileId, authProfileIdSource } = runtimeSelectionForHarness;
  let externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
    provider: model.provider,
    cfg: params.cfg,
    agentId: sessionAgentId,
    modelId: model.id,
    workspaceDir,
    userLockedAuthProfileId: authProfileIdSource === "user" ? authProfileId : undefined,
  });
  if (!externalCliAuthScope.providerIds) {
    const noExternalAuthStore = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      allowKeychainPrompt: false,
    });
    externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
      provider: model.provider,
      cfg: params.cfg,
      agentId: sessionAgentId,
      modelId: model.id,
      workspaceDir,
      store: noExternalAuthStore,
      userLockedAuthProfileId: authProfileIdSource === "user" ? authProfileId : undefined,
    });
  }
  const authStore = externalCliAuthScope.providerIds
    ? ensureAuthProfileStore(params.agentDir, {
        externalCliProviderIds: externalCliAuthScope.providerIds,
        allowKeychainPrompt: false,
      })
    : undefined;
  const effectiveAuthProfileId =
    externalCliAuthScope.ignoreAutoPreferredProfile && authProfileIdSource !== "user"
      ? undefined
      : authProfileId;
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    profileId: effectiveAuthProfileId,
    ...(authStore ? { store: authStore } : {}),
    agentDir: params.agentDir,
    secretSentinels: true,
  });
  const resolvedAuthProfileId = apiKeyInfo.profileId ?? effectiveAuthProfileId;
  let runtimeModel = model;
  let apiKey =
    apiKeyInfo.mode === "aws-sdk" && !apiKeyInfo.apiKey
      ? undefined
      : requireApiKey(apiKeyInfo, model.provider);
  if (apiKey) {
    const preparedAuth = protectPreparedProviderRuntimeAuth({
      sourceApiKey: apiKey,
      provider: model.provider,
      preparedAuth: await prepareProviderRuntimeAuth({
        provider: model.provider,
        config: params.cfg,
        workspaceDir,
        env: process.env,
        context: {
          config: params.cfg,
          agentDir: params.agentDir,
          workspaceDir,
          env: process.env,
          provider: model.provider,
          modelId: model.id,
          model,
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
  });
  const streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: streamSimple,
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
