/**
 * Agent session SDK factory.
 *
 * Selects models, wires built-in/custom tools, loads resources, and creates AgentSession instances.
 */
import { join } from "node:path";
import { clampThinkingLevel } from "@openclaw/ai/internal/runtime";
import {
  resolveThinkingDefaultForModel,
  type ThinkingCatalogEntry,
} from "../../auto-reply/thinking.js";
import { streamSimple } from "../../llm/stream.js";
import type { Message, Model } from "../../llm/types.js";
import { getAgentDir } from "../config.js";
import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type ThinkingLevel,
} from "../runtime/index.js";
import { AgentSession, type AgentSessionWriteLockRunner } from "./agent-session.js";
import { formatNoModelsAvailableMessage } from "./auth-guidance.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type {
  ExtensionRunner,
  LoadExtensionsResult,
  SessionStartEvent,
  ToolDefinition,
} from "./extensions/index.js";
import { convertToLlm } from "./messages.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import { DefaultResourceLoader, type ResourceLoader } from "./resource-loader.js";
import { getDefaultSessionDir, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { isInstallTelemetryEnabled } from "./telemetry.js";
import {
  createCodingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ToolName,
} from "./tools/index.js";

type ThinkingCatalogCompat = NonNullable<ThinkingCatalogEntry["compat"]>;

function projectThinkingCatalogCompat(compat: Model["compat"]) {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const record = compat as Record<string, unknown>;
  const projected: ThinkingCatalogCompat = {};
  if (typeof record.thinkingFormat === "string") {
    projected.thinkingFormat = record.thinkingFormat;
  }
  if (record.supportedReasoningEfforts === null) {
    projected.supportedReasoningEfforts = null;
  } else if (
    Array.isArray(record.supportedReasoningEfforts) &&
    record.supportedReasoningEfforts.every((effort) => typeof effort === "string")
  ) {
    projected.supportedReasoningEfforts = record.supportedReasoningEfforts;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

export interface CreateAgentSessionOptions {
  /** Working directory for project-local discovery. Default: process.cwd() */
  cwd?: string;
  /** Global config directory. Default: ~/.openclaw/agents/default */
  agentDir?: string;

  /** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
  authStorage?: AuthStorage;
  /** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
  modelRegistry?: ModelRegistry;

  /** Model to use. Default: from settings, else first available */
  model?: Model;
  /** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
  thinkingLevel?: ThinkingLevel;
  /** Models available for cycling (Ctrl+P in interactive mode) */
  scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

  /**
   * Optional default tool suppression mode when no explicit allowlist is provided.
   *
   * - "all": start with no tools enabled
   * - "builtin": disable the default built-in tools (read, bash, edit, write)
   *   but keep extension/custom tools enabled
   */
  noTools?: "all" | "builtin";
  /**
   * Optional allowlist of tool names.
   *
   * When omitted, OpenClaw enables the default built-in tools (read, bash, edit, write)
   * and leaves extension/custom tools enabled unless `noTools` changes that default.
   * When provided, only the listed tool names are enabled.
   */
  tools?: string[];
  /** Custom tools to register (in addition to built-in tools). */
  customTools?: ToolDefinition[];
  /** Hydrate an authorized tool deferred out of the current provider-visible tool set. */
  resolveDeferredTool?: AgentOptions["resolveDeferredTool"];

  /** Resource loader. When omitted, DefaultResourceLoader is used. */
  resourceLoader?: ResourceLoader;

  /** Session manager. Default: SessionManager.create(cwd) */
  sessionManager?: SessionManager;

  /** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
  settingsManager?: SettingsManager;
  /** Session start event metadata for extension runtime startup. */
  sessionStartEvent?: SessionStartEvent;
  /** Optional lock used before session-file writes or write-capable extension hooks. */
  withSessionWriteLock?: AgentSessionWriteLockRunner;
}

/** Result from createAgentSession */
interface CreateAgentSessionResult {
  /** The created session */
  session: AgentSession;
  /** Extensions result (for UI context setup in interactive mode) */
  extensionsResult: LoadExtensionsResult;
  /** Warning if session was restored with a different model than saved */
  modelFallbackMessage?: string;
}

// Re-exports

export type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "./extensions/index.js";

export { createCodingTools, createReadTool, createEditTool, createWriteTool };

// Helper Functions

function getDefaultAgentDir(): string {
  return getAgentDir();
}

function createSessionPrepareNextTurnWithContext(
  getAgent: () => Agent,
): NonNullable<AgentOptions["prepareNextTurnWithContext"]> {
  let activeRunMessages: AgentMessage[] | undefined;
  let effectiveModel: Model | undefined;
  let effectiveThinkingLevel: ThinkingLevel | undefined;
  let lastSessionModel: Model | undefined;
  let lastSessionThinkingLevel: ThinkingLevel | undefined;
  let lastSessionPrompt: string | undefined;
  let lastSessionTools: AgentTool[] = [];
  const sameTools = (left: AgentTool[], right: AgentTool[]) =>
    left.length === right.length && left.every((tool, index) => tool === right[index]);

  return async (turn, signal) => {
    const agent = getAgent();
    const firstTurnInRun = activeRunMessages !== turn.newMessages;
    if (firstTurnInRun) {
      activeRunMessages = turn.newMessages;
      effectiveModel = agent.state.model;
      effectiveThinkingLevel = agent.state.thinkingLevel;
    }

    const previousSnapshot = await agent.prepareNextTurn?.(signal);
    const sessionPrompt = agent.state.systemPrompt;
    const sessionTools = agent.state.tools;
    const sessionModelChanged = firstTurnInRun || agent.state.model !== lastSessionModel;
    const sessionThinkingChanged =
      firstTurnInRun || agent.state.thinkingLevel !== lastSessionThinkingLevel;
    const sessionPromptChanged = firstTurnInRun || sessionPrompt !== lastSessionPrompt;
    const sessionToolsChanged = firstTurnInRun || !sameTools(sessionTools, lastSessionTools);

    // Loop-only hook updates persist for the run; fresh session state wins only after it changes.
    effectiveModel =
      previousSnapshot?.model ?? (sessionModelChanged ? agent.state.model : effectiveModel);
    effectiveThinkingLevel =
      previousSnapshot?.thinkingLevel ??
      (sessionThinkingChanged ? agent.state.thinkingLevel : effectiveThinkingLevel);

    lastSessionModel = agent.state.model;
    lastSessionThinkingLevel = agent.state.thinkingLevel;
    lastSessionPrompt = sessionPrompt;
    lastSessionTools = sessionTools.slice();

    const nextContext = previousSnapshot?.context
      ? { ...previousSnapshot.context }
      : {
          ...turn.context,
          systemPrompt: sessionPromptChanged ? sessionPrompt : turn.context.systemPrompt,
          tools: sessionToolsChanged ? sessionTools.slice() : turn.context.tools?.slice(),
        };

    return {
      ...previousSnapshot,
      context: nextContext,
      model: effectiveModel,
      thinkingLevel: effectiveThinkingLevel,
    };
  };
}

function getAttributionHeaders(
  model: Model,
  settingsManager: SettingsManager,
): Record<string, string> | undefined {
  if (!isInstallTelemetryEnabled(settingsManager)) {
    return undefined;
  }

  const baseUrl = (model as { baseUrl?: string }).baseUrl ?? "";

  if (model.provider === "openrouter" || baseUrl.includes("openrouter.ai")) {
    return {
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "cli-agent",
    };
  }

  if (
    model.provider === "cloudflare-workers-ai" ||
    model.provider === "cloudflare-ai-gateway" ||
    baseUrl.includes("api.cloudflare.com") ||
    baseUrl.includes("gateway.ai.cloudflare.com")
  ) {
    return {
      "User-Agent": "openclaw",
    };
  }

  return undefined;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model from the configured registry
 * const model = ModelRegistry.create(AuthStorage.load()).find('anthropic', 'claude-opus-4-5');
 * const { session } = await createAgentSession({
 *   model,
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
  const agentDir = options.agentDir ?? getDefaultAgentDir();
  let resourceLoader = options.resourceLoader;

  // Use provided or create AuthStorage and ModelRegistry
  const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
  const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
  const authStorage = options.authStorage ?? AuthStorage.create(authPath);
  const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const sessionManager =
    options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

  if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await resourceLoader.reload();
  }

  // Check if session has existing data to restore
  const existingSession = sessionManager.buildSessionContext();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry = sessionManager
    .getBranch()
    .some((entry) => entry.type === "thinking_level_change");

  let model = options.model;
  let modelFallbackMessage: string | undefined;

  // If session has data, try to restore model from it
  if (!model && hasExistingSession && existingSession.model) {
    const restoredModel = modelRegistry.find(
      existingSession.model.provider,
      existingSession.model.modelId,
    );
    if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
      model = restoredModel;
    }
    if (!model) {
      modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
    }
  }

  // If still no model, use findInitialModel (checks settings default, then provider defaults)
  if (!model) {
    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: hasExistingSession,
      defaultProvider: settingsManager.getDefaultProvider(),
      defaultModelId: settingsManager.getDefaultModel(),
      defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
      modelRegistry,
    });
    model = result.model;
    if (!model) {
      modelFallbackMessage = formatNoModelsAvailableMessage();
    } else if (modelFallbackMessage) {
      modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
    }
  }

  let thinkingLevel = options.thinkingLevel;

  // Use "off" when a provider explicitly opts out of thinking (e.g. Ollama). Non-off
  // provider defaults (high, low, adaptive) fall back to DEFAULT_THINKING_LEVEL to avoid
  // silent cost changes for DeepSeek, OpenRouter, xAI, and other providers.
  const modelThinkingProvider = model?.api === "ollama" ? "ollama" : model?.provider;
  const modelThinkingCompat = model ? projectThinkingCatalogCompat(model.compat) : undefined;
  const resolvedProviderDefault =
    model && modelThinkingProvider
      ? resolveThinkingDefaultForModel({
          provider: modelThinkingProvider,
          model: model.id,
          catalog: [
            {
              provider: modelThinkingProvider,
              id: model.id,
              api: model.api,
              reasoning: model.reasoning,
              ...(model.params ? { params: model.params } : {}),
              ...(modelThinkingCompat ? { compat: modelThinkingCompat } : {}),
            },
          ],
        })
      : undefined;
  const modelThinkingDefault: ThinkingLevel =
    resolvedProviderDefault === "off" ? "off" : DEFAULT_THINKING_LEVEL;

  // If session has data, restore thinking level from it
  if (thinkingLevel === undefined && hasExistingSession) {
    thinkingLevel = hasThinkingEntry
      ? (existingSession.thinkingLevel as ThinkingLevel)
      : (settingsManager.getDefaultThinkingLevel() ?? modelThinkingDefault);
  }

  // Fall back to settings default
  if (thinkingLevel === undefined) {
    thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? modelThinkingDefault;
  }

  // Clamp to model capabilities
  if (!model) {
    thinkingLevel = "off";
  } else {
    thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
  }

  const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
  const customToolNames = options.customTools?.map((tool) => tool.name) ?? [];
  const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
  const disableBuiltInTools = !options.tools && options.noTools === "builtin";
  const initialActiveToolNames: string[] = options.tools
    ? [...options.tools]
    : options.noTools === "all"
      ? []
      : options.noTools === "builtin"
        ? customToolNames
        : defaultActiveToolNames;

  // Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
  const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
    const converted = convertToLlm(messages);
    // Check setting dynamically so mid-session changes take effect
    if (!settingsManager.getBlockImages()) {
      return converted;
    }
    // Filter out ImageContent from all messages, replacing with text placeholder
    return converted.map((msg) => {
      if (msg.role === "user" || msg.role === "toolResult") {
        const content = msg.content;
        if (Array.isArray(content)) {
          const hasImages = content.some((c) => c.type === "image");
          if (hasImages) {
            const filteredContent = content
              .map((c) =>
                c.type === "image"
                  ? { type: "text" as const, text: "Image reading is disabled." }
                  : c,
              )
              .filter((c, i, arr) => {
                const previous = arr.at(i - 1);
                // Dedupe consecutive "Image reading is disabled." texts
                return !(
                  c.type === "text" &&
                  c.text === "Image reading is disabled." &&
                  i > 0 &&
                  previous?.type === "text" &&
                  previous.text === "Image reading is disabled."
                );
              });
            return Object.assign({}, msg, { content: filteredContent });
          }
        }
      }
      return msg;
    });
  };

  const extensionRunnerRef: { current?: ExtensionRunner } = {};
  const runWithSessionWriteLock = async <T>(run: () => Promise<T> | T): Promise<T> =>
    options.withSessionWriteLock ? await options.withSessionWriteLock(run) : await run();

  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: "",
      model,
      thinkingLevel,
      tools: [],
    },
    convertToLlm: convertToLlmWithBlockImages,
    streamFn: async (modelResult, context, optionsLocal) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(modelResult);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      const providerRetrySettings = settingsManager.getProviderRetrySettings();
      const attributionHeaders = getAttributionHeaders(modelResult, settingsManager);
      return streamSimple(modelResult, context, {
        ...optionsLocal,
        apiKey: auth.apiKey,
        timeoutMs: optionsLocal?.timeoutMs ?? providerRetrySettings.timeoutMs,
        maxRetries: optionsLocal?.maxRetries ?? providerRetrySettings.maxRetries,
        maxRetryDelayMs: optionsLocal?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
        headers:
          attributionHeaders || auth.headers || optionsLocal?.headers
            ? { ...attributionHeaders, ...auth.headers, ...optionsLocal?.headers }
            : undefined,
      });
    },
    onPayload: async (payload, modelValue) => {
      void modelValue;
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("before_provider_request")) {
        return payload;
      }
      return await runWithSessionWriteLock(
        async () => await runner.emitBeforeProviderRequest(payload),
      );
    },
    onResponse: async (response, modelLocal) => {
      void modelLocal;
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("after_provider_response")) {
        return;
      }
      await runWithSessionWriteLock(
        async () =>
          await runner.emit({
            type: "after_provider_response",
            status: response.status,
            headers: response.headers,
          }),
      );
    },
    sessionId: sessionManager.getSessionId(),
    transformContext: async (messages) => {
      const runner = extensionRunnerRef.current;
      if (!runner) {
        return messages;
      }
      return runner.emitContext(messages);
    },
    resolveDeferredTool: options.resolveDeferredTool,
    prepareNextTurnWithContext: createSessionPrepareNextTurnWithContext(() => agent),
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    transport: settingsManager.getTransport(),
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
  });

  // Restore messages if session has existing data
  if (hasExistingSession) {
    agent.state.messages = existingSession.messages;
    if (!hasThinkingEntry) {
      sessionManager.appendThinkingLevelChange(thinkingLevel);
    }
  } else {
    // Save initial model and thinking level for new sessions so they can be restored on resume
    if (model) {
      sessionManager.appendModelChange(model.provider, model.id);
    }
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }

  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    scopedModels: options.scopedModels,
    resourceLoader,
    customTools: options.customTools,
    modelRegistry,
    initialActiveToolNames,
    allowedToolNames,
    disableBuiltInTools,
    extensionRunnerRef,
    sessionStartEvent: options.sessionStartEvent,
    withSessionWriteLock: options.withSessionWriteLock,
  });
  const extensionsResult = resourceLoader.getExtensions();

  return {
    session,
    extensionsResult,
    modelFallbackMessage,
  };
}
