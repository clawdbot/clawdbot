import {
  embeddedAgentLog,
  isActiveHarnessContextEngine,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildCodexUserMcpServersThreadConfigPatch } from "openclaw/plugin-sdk/codex-mcp-projection";
import {
  CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY,
  renderCodexPromptOverlay,
} from "../../prompt-overlay.js";
import { isModernCodexModel } from "../../provider.js";
import { isCodexAppServerConnectionClosedError, type CodexAppServerClient } from "./client.js";
import { codexSandboxPolicyForTurn, type CodexAppServerRuntimeOptions } from "./config.js";
import {
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
} from "./context-engine-projection.js";
import {
  isCodexPluginThreadBindingStale,
  mergeCodexThreadConfigs,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import {
  assertCodexThreadResumeResponse,
  assertCodexThreadStartResponse,
} from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexDynamicToolSpec,
  type CodexThreadResumeParams,
  type CodexThreadStartParams,
  type CodexTurnStartParams,
  type CodexUserInput,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import {
  clearCodexAppServerBinding,
  isCodexAppServerNativeAuthProfile,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerContextEngineBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

export type CodexAppServerThreadLifecycle = {
  action: "started" | "resumed";
  rotatedContextEngineBinding?: boolean;
};

export type CodexAppServerThreadLifecycleBinding = CodexAppServerThreadBinding & {
  lifecycle: CodexAppServerThreadLifecycle;
};

export type CodexPluginThreadConfigProvider = {
  enabled: boolean;
  inputFingerprint?: string;
  enabledPluginConfigKeys?: readonly string[];
  build: () => Promise<CodexPluginThreadConfig>;
};

export const CODEX_CODE_MODE_THREAD_CONFIG: JsonObject = {
  "features.code_mode": true,
  "features.code_mode_only": true,
};

export async function startOrResumeThread(params: {
  client: CodexAppServerClient;
  params: EmbeddedRunAttemptParams;
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  config?: JsonObject;
  mcpServersFingerprint?: string;
  mcpServersFingerprintEvaluated?: boolean;
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
}): Promise<CodexAppServerThreadLifecycleBinding> {
  const dynamicToolsFingerprint = fingerprintDynamicTools(params.dynamicTools);
  const contextEngineBinding = buildContextEngineBinding(params.params);
  const userMcpServersConfigPatch = buildCodexUserMcpServersThreadConfigPatch(params.params.config);
  const userMcpServersFingerprint = fingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
  let binding = await readCodexAppServerBinding(params.params.sessionFile, {
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    config: params.params.config,
  });
  let preserveExistingBinding = false;
  let rotatedContextEngineBinding = false;
  let prebuiltPluginThreadConfig: CodexPluginThreadConfig | undefined;
  if (binding?.threadId && (binding.contextEngine || contextEngineBinding)) {
    if (
      !contextEngineBinding ||
      !isContextEngineBindingCompatible(binding.contextEngine, contextEngineBinding)
    ) {
      embeddedAgentLog.debug(
        "codex app-server context-engine binding changed; starting a new thread",
        {
          threadId: binding.threadId,
          engineId: contextEngineBinding?.engineId,
          previousEngineId: binding.contextEngine?.engineId,
        },
      );
      await clearCodexAppServerBinding(params.params.sessionFile);
      binding = undefined;
      rotatedContextEngineBinding = true;
    }
  }
  if (binding?.threadId && binding.userMcpServersFingerprint !== userMcpServersFingerprint) {
    embeddedAgentLog.debug("codex app-server user MCP config changed; starting a new thread", {
      threadId: binding.threadId,
    });
    await clearCodexAppServerBinding(params.params.sessionFile);
    binding = undefined;
  }
  if (
    binding?.threadId &&
    params.mcpServersFingerprintEvaluated === true &&
    binding.mcpServersFingerprint !== params.mcpServersFingerprint
  ) {
    embeddedAgentLog.debug("codex app-server MCP config changed; starting a new thread", {
      threadId: binding.threadId,
    });
    await clearCodexAppServerBinding(params.params.sessionFile);
    binding = undefined;
  }
  if (binding?.threadId) {
    let pluginBindingStale = isCodexPluginThreadBindingStale({
      codexPluginsEnabled: params.pluginThreadConfig?.enabled ?? false,
      bindingFingerprint: binding.pluginAppsFingerprint,
      bindingInputFingerprint: binding.pluginAppsInputFingerprint,
      currentInputFingerprint: params.pluginThreadConfig?.inputFingerprint,
      hasBindingPolicyContext: Boolean(binding.pluginAppPolicyContext),
    });
    if (
      !pluginBindingStale &&
      shouldRecheckRecoverablePluginBinding({
        binding,
        pluginThreadConfig: params.pluginThreadConfig,
      })
    ) {
      try {
        prebuiltPluginThreadConfig = await params.pluginThreadConfig?.build();
        pluginBindingStale =
          prebuiltPluginThreadConfig?.fingerprint !== binding.pluginAppsFingerprint;
      } catch (error) {
        embeddedAgentLog.warn("codex app-server plugin app config recovery check failed", {
          error,
          threadId: binding.threadId,
        });
      }
    }
    if (pluginBindingStale) {
      embeddedAgentLog.debug("codex app-server plugin app config changed; starting a new thread", {
        threadId: binding.threadId,
      });
      await clearCodexAppServerBinding(params.params.sessionFile);
      binding = undefined;
    }
  }
  if (
    binding?.threadId &&
    params.mcpServersFingerprintEvaluated === true &&
    binding.mcpServersFingerprint !== params.mcpServersFingerprint
  ) {
    embeddedAgentLog.debug("codex app-server MCP config changed; starting a new thread", {
      threadId: binding.threadId,
    });
    await clearCodexAppServerBinding(params.params.sessionFile);
    binding = undefined;
  }
  if (binding?.threadId) {
    // `/codex resume <thread>` writes a binding before the next turn can know
    // the dynamic tool catalog, so only invalidate fingerprints we actually have.
    if (
      binding.dynamicToolsFingerprint &&
      !areDynamicToolFingerprintsCompatible(
        binding.dynamicToolsFingerprint,
        dynamicToolsFingerprint,
      )
    ) {
      preserveExistingBinding = shouldStartTransientNoToolThread({
        previous: binding.dynamicToolsFingerprint,
        next: dynamicToolsFingerprint,
      });
      if (preserveExistingBinding) {
        embeddedAgentLog.debug(
          "codex app-server dynamic tools unavailable for turn; starting transient thread",
          {
            threadId: binding.threadId,
          },
        );
      } else {
        embeddedAgentLog.debug(
          "codex app-server dynamic tool catalog changed; starting a new thread",
          {
            threadId: binding.threadId,
          },
        );
        await clearCodexAppServerBinding(params.params.sessionFile);
      }
    } else {
      try {
        const authProfileId = params.params.authProfileId ?? binding.authProfileId;
        const resumeConfig = mergeCodexThreadConfigs(params.config, userMcpServersConfigPatch);
        const response = assertCodexThreadResumeResponse(
          await params.client.request(
            "thread/resume",
            buildThreadResumeParams(params.params, {
              threadId: binding.threadId,
              authProfileId,
              appServer: params.appServer,
              developerInstructions: params.developerInstructions,
              config: resumeConfig,
            }),
          ),
        );
        const boundAuthProfileId = authProfileId;
        const fallbackModelProvider = resolveCodexAppServerModelProvider({
          provider: params.params.provider,
          authProfileId: boundAuthProfileId,
          authProfileStore: params.params.authProfileStore,
          agentDir: params.params.agentDir,
          config: params.params.config,
        });
        const nextMcpServersFingerprint =
          params.mcpServersFingerprintEvaluated === true
            ? params.mcpServersFingerprint
            : binding.mcpServersFingerprint;
        await writeCodexAppServerBinding(
          params.params.sessionFile,
          {
            threadId: response.thread.id,
            cwd: params.cwd,
            authProfileId: boundAuthProfileId,
            model: params.params.modelId,
            modelProvider: response.modelProvider ?? fallbackModelProvider,
            dynamicToolsFingerprint,
            userMcpServersFingerprint,
            mcpServersFingerprint: nextMcpServersFingerprint,
            pluginAppsFingerprint: binding.pluginAppsFingerprint,
            pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
            pluginAppPolicyContext: binding.pluginAppPolicyContext,
            contextEngine: contextEngineBinding,
            createdAt: binding.createdAt,
          },
          {
            authProfileStore: params.params.authProfileStore,
            agentDir: params.params.agentDir,
            config: params.params.config,
          },
        );
        return {
          ...binding,
          threadId: response.thread.id,
          cwd: params.cwd,
          authProfileId: boundAuthProfileId,
          model: params.params.modelId,
          modelProvider: response.modelProvider ?? fallbackModelProvider,
          dynamicToolsFingerprint,
          userMcpServersFingerprint,
          mcpServersFingerprint: nextMcpServersFingerprint,
          pluginAppsFingerprint: binding.pluginAppsFingerprint,
          pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
          pluginAppPolicyContext: binding.pluginAppPolicyContext,
          contextEngine: contextEngineBinding,
          lifecycle: { action: "resumed" },
        };
      } catch (error) {
        if (isCodexAppServerConnectionClosedError(error)) {
          throw error;
        }
        embeddedAgentLog.warn("codex app-server thread resume failed; starting a new thread", {
          error,
        });
        await clearCodexAppServerBinding(params.params.sessionFile);
      }
    }
  }

  const pluginThreadConfig = params.pluginThreadConfig?.enabled
    ? (prebuiltPluginThreadConfig ?? (await params.pluginThreadConfig.build()))
    : undefined;
  const config = mergeCodexThreadConfigs(
    params.config,
    userMcpServersConfigPatch,
    pluginThreadConfig?.configPatch,
  );
  const response = assertCodexThreadStartResponse(
    await params.client.request(
      "thread/start",
      buildThreadStartParams(params.params, {
        cwd: params.cwd,
        dynamicTools: params.dynamicTools,
        appServer: params.appServer,
        developerInstructions: params.developerInstructions,
        config,
      }),
    ),
  );
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.params.provider,
    authProfileId: params.params.authProfileId,
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    config: params.params.config,
  });
  const createdAt = new Date().toISOString();
  const nextMcpServersFingerprint =
    params.mcpServersFingerprintEvaluated === true ? params.mcpServersFingerprint : undefined;
  if (!preserveExistingBinding) {
    await writeCodexAppServerBinding(
      params.params.sessionFile,
      {
        threadId: response.thread.id,
        cwd: params.cwd,
        authProfileId: params.params.authProfileId,
        model: response.model ?? params.params.modelId,
        modelProvider: response.modelProvider ?? modelProvider,
        dynamicToolsFingerprint,
        userMcpServersFingerprint,
        mcpServersFingerprint: nextMcpServersFingerprint,
        pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
        pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
        pluginAppPolicyContext: pluginThreadConfig?.policyContext,
        contextEngine: contextEngineBinding,
        createdAt,
      },
      {
        authProfileStore: params.params.authProfileStore,
        agentDir: params.params.agentDir,
        config: params.params.config,
      },
    );
  }
  return {
    schemaVersion: 1,
    threadId: response.thread.id,
    sessionFile: params.params.sessionFile,
    cwd: params.cwd,
    authProfileId: params.params.authProfileId,
    model: response.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? modelProvider,
    dynamicToolsFingerprint,
    userMcpServersFingerprint,
    mcpServersFingerprint: nextMcpServersFingerprint,
    pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
    pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
    pluginAppPolicyContext: pluginThreadConfig?.policyContext,
    contextEngine: contextEngineBinding,
    createdAt,
    updatedAt: createdAt,
    lifecycle: {
      action: "started",
      ...(rotatedContextEngineBinding ? { rotatedContextEngineBinding } : {}),
    },
  };
}

function buildContextEngineBinding(
  params: EmbeddedRunAttemptParams,
): CodexAppServerContextEngineBinding | undefined {
  const contextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const engineId = contextEngine?.info?.id?.trim();
  if (!contextEngine || !engineId) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    engineId,
    policyFingerprint: JSON.stringify({
      schemaVersion: 1,
      engineId,
      engineVersion: contextEngine.info.version,
      ownsCompaction: contextEngine.info.ownsCompaction === true,
      turnMaintenanceMode: contextEngine.info.turnMaintenanceMode,
      citationsMode: resolveContextEngineCitationsMode(params.config),
      contextTokenBudget: params.contextTokenBudget,
      projectionMaxChars: resolveCodexContextEngineProjectionMaxChars({
        contextTokenBudget: params.contextTokenBudget,
        reserveTokens: resolveCodexContextEngineProjectionReserveTokens({
          config: params.config,
        }),
      }),
    }),
  };
}

function isContextEngineBindingCompatible(
  previous: CodexAppServerContextEngineBinding | undefined,
  next: CodexAppServerContextEngineBinding,
): boolean {
  return (
    previous?.schemaVersion === next.schemaVersion &&
    previous.engineId === next.engineId &&
    previous.policyFingerprint === next.policyFingerprint
  );
}

function resolveContextEngineCitationsMode(config: unknown): JsonValue | undefined {
  const rootConfig = isUnknownRecord(config) ? config : undefined;
  const memoryConfig = isUnknownRecord(rootConfig?.memory) ? rootConfig.memory : undefined;
  const citations = memoryConfig?.citations;
  return isJsonConfigValue(citations) ? citations : undefined;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonConfigValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonConfigValue);
  }
  return isUnknownRecord(value) && Object.values(value).every(isJsonConfigValue);
}

function shouldRecheckRecoverablePluginBinding(params: {
  binding: CodexAppServerThreadBinding;
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
}): boolean {
  if (!params.pluginThreadConfig?.enabled) {
    return false;
  }
  if (
    !params.binding.pluginAppsFingerprint ||
    !params.binding.pluginAppsInputFingerprint ||
    params.binding.pluginAppsInputFingerprint !== params.pluginThreadConfig.inputFingerprint
  ) {
    return false;
  }
  const policyContext = params.binding.pluginAppPolicyContext;
  if (!policyContext) {
    return false;
  }
  const expectedPluginConfigKeys = params.pluginThreadConfig.enabledPluginConfigKeys ?? [];
  return Object.keys(policyContext.apps).length === 0 || expectedPluginConfigKeys.length > 0;
}

export function buildThreadStartParams(
  params: EmbeddedRunAttemptParams,
  options: {
    cwd: string;
    dynamicTools: CodexDynamicToolSpec[];
    appServer: CodexAppServerRuntimeOptions;
    developerInstructions?: string;
    config?: JsonObject;
  },
): CodexThreadStartParams {
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    model: params.modelId,
    ...(modelProvider ? { modelProvider } : {}),
    cwd: options.cwd,
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    sandbox: options.appServer.sandbox,
    ...(options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {}),
    serviceName: "OpenClaw",
    config: buildCodexRuntimeThreadConfig(options.config),
    developerInstructions: options.developerInstructions ?? buildDeveloperInstructions(params),
    dynamicTools: options.dynamicTools,
    experimentalRawEvents: true,
    persistExtendedHistory: true,
  };
}

export function buildThreadResumeParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    authProfileId?: string;
    appServer: CodexAppServerRuntimeOptions;
    developerInstructions?: string;
    config?: JsonObject;
  },
): CodexThreadResumeParams {
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId: options.authProfileId ?? params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    threadId: options.threadId,
    model: params.modelId,
    ...(modelProvider ? { modelProvider } : {}),
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    sandbox: options.appServer.sandbox,
    ...(options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {}),
    config: buildCodexRuntimeThreadConfig(options.config),
    developerInstructions: options.developerInstructions ?? buildDeveloperInstructions(params),
    persistExtendedHistory: true,
  };
}

export function buildCodexRuntimeThreadConfig(config: JsonObject | undefined): JsonObject {
  return (
    mergeCodexThreadConfigs(config, CODEX_CODE_MODE_THREAD_CONFIG) ?? {
      ...CODEX_CODE_MODE_THREAD_CONFIG,
    }
  );
}

export function buildTurnStartParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    cwd: string;
    appServer: CodexAppServerRuntimeOptions;
    promptText?: string;
  },
): CodexTurnStartParams {
  return {
    threadId: options.threadId,
    input: buildUserInput(params, options.promptText),
    cwd: options.cwd,
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    sandboxPolicy: codexSandboxPolicyForTurn(options.appServer.sandbox, options.cwd),
    model: params.modelId,
    ...(options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {}),
    effort: resolveReasoningEffort(params.thinkLevel, params.modelId),
    collaborationMode: buildTurnCollaborationMode(params),
  };
}

type CodexTurnCollaborationMode = NonNullable<CodexTurnStartParams["collaborationMode"]>;

export function buildTurnCollaborationMode(
  params: EmbeddedRunAttemptParams,
): CodexTurnCollaborationMode {
  return {
    mode: "default",
    settings: {
      model: params.modelId,
      reasoning_effort: resolveReasoningEffort(params.thinkLevel, params.modelId),
      developer_instructions: buildTurnScopedCollaborationInstructions(params),
    },
  };
}

function buildTurnScopedCollaborationInstructions(params: EmbeddedRunAttemptParams): string | null {
  if (params.trigger === "cron") {
    return buildCronCollaborationInstructions();
  }
  if (params.trigger === "heartbeat") {
    return buildHeartbeatCollaborationInstructions();
  }
  return null;
}

function buildCronCollaborationInstructions(): string {
  return [
    "This is an OpenClaw cron automation turn. Apply these instructions only to this scheduled job; ordinary chat turns should stay in Codex Default mode.",
    "Execute the cron payload directly. If it asks you to run an exact command, run that command before doing any investigation, planning, memory review, or workspace bootstrap.",
    "Do not read AGENTS.md, SOUL.md, USER.md, PROJECTS.md, MEMORY.md, day logs, entity summaries, or other workspace memory/bootstrap files unless the cron payload explicitly asks you to inspect them or the requested command fails and the file is needed to diagnose that failure.",
    "Keep output concise and automation-oriented. Prefer the final command result or a short failure summary over status narration.",
  ].join("\n\n");
}

function buildHeartbeatCollaborationInstructions(): string {
  return [
    "This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake; ordinary chat turns should stay in Codex Default mode.",
    "When you are ready to end the heartbeat, prefer the structured `heartbeat_respond` tool so OpenClaw can record the wake outcome and notification decision. If `heartbeat_respond` is not already available and `tool_search` is available, search for `heartbeat_respond`, load it, then call it. Use `notify=false` when nothing should visibly interrupt the user.",
    CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY,
  ].join("\n\n");
}

export function codexDynamicToolsFingerprint(dynamicTools: CodexDynamicToolSpec[]): string {
  return fingerprintDynamicTools(dynamicTools);
}

export function areCodexDynamicToolFingerprintsCompatible(params: {
  previous?: string;
  next: string;
}): boolean {
  return areDynamicToolFingerprintsCompatible(params.previous, params.next);
}

function fingerprintDynamicTools(dynamicTools: CodexDynamicToolSpec[]): string {
  return JSON.stringify(
    dynamicTools.map(fingerprintDynamicToolSpec).toSorted(compareJsonFingerprint),
  );
}

function fingerprintUserMcpServersConfigPatch(
  configPatch: JsonObject | undefined,
): string | undefined {
  return configPatch ? JSON.stringify(stabilizeJsonValue(configPatch)) : undefined;
}

function fingerprintDynamicToolSpec(tool: JsonValue): JsonValue {
  if (!isJsonObject(tool)) {
    return stabilizeJsonValue(tool);
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(tool).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (key === "description") {
      continue;
    }
    stable[key] = stabilizeJsonValue(child);
  }
  return stable;
}

function stabilizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    stable[key] = stabilizeJsonValue(child);
  }
  return stable;
}

const EMPTY_DYNAMIC_TOOLS_FINGERPRINT = JSON.stringify([]);

function areDynamicToolFingerprintsCompatible(previous: string | undefined, next: string): boolean {
  return !previous || previous === next;
}

function shouldStartTransientNoToolThread(params: {
  previous: string | undefined;
  next: string;
}): boolean {
  return Boolean(
    params.previous &&
    params.previous !== EMPTY_DYNAMIC_TOOLS_FINGERPRINT &&
    params.next === EMPTY_DYNAMIC_TOOLS_FINGERPRINT,
  );
}

function compareJsonFingerprint(left: JsonValue, right: JsonValue): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

export function buildDeveloperInstructions(params: EmbeddedRunAttemptParams): string {
  const promptOverlay = renderCodexRuntimePromptOverlay(params);
  const sections = [
    "Running inside OpenClaw. Use dynamic tools for messaging, cron, sessions, media, gateway, and nodes when available.",
    "Preserve channel/session context. Visible channel replies: use `message`, do not describe would-reply.",
    promptOverlay,
    params.extraSystemPrompt,
    params.skillsSnapshot?.prompt,
  ];
  return sections.filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}

function renderCodexRuntimePromptOverlay(params: EmbeddedRunAttemptParams): string | undefined {
  const contribution = params.runtimePlan?.prompt.resolveSystemPromptContribution({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    modelId: params.modelId,
    promptMode: "full",
    agentId: params.agentId,
  });
  if (!contribution) {
    return renderCodexPromptOverlay({
      config: params.config,
      providerId: params.provider,
      modelId: params.modelId,
    });
  }
  return [
    contribution.stablePrefix,
    ...Object.values(contribution.sectionOverrides ?? {}),
    contribution.dynamicSuffix,
  ]
    .filter(
      (section): section is string => typeof section === "string" && section.trim().length > 0,
    )
    .join("\n\n");
}

function buildUserInput(
  params: EmbeddedRunAttemptParams,
  promptText: string = params.prompt,
): CodexUserInput[] {
  return [
    { type: "text", text: promptText, text_elements: [] },
    ...(params.images ?? []).map(
      (image): CodexUserInput => ({
        type: "image",
        url: `data:${image.mimeType};base64,${image.data}`,
      }),
    ),
  ];
}

export function resolveCodexAppServerModelProvider(params: {
  provider: string;
  authProfileId?: string;
  authProfileStore?: CodexAppServerAuthProfileLookup["authProfileStore"];
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): string | undefined {
  const normalized = params.provider.trim();
  const normalizedLower = normalized.toLowerCase();
  if (!normalized || normalizedLower === "codex") {
    // `codex` is OpenClaw's virtual provider; let Codex app-server keep its
    // native provider/auth selection instead of forcing the legacy OpenAI path.
    return undefined;
  }
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    (normalizedLower === "openai" || normalizedLower === "openai-codex")
  ) {
    // When OpenClaw is forwarding ChatGPT/Codex OAuth, `openai` is Codex's
    // native provider id, not a public OpenAI API-key choice. Omit the override
    // so app-server keeps its configured provider/auth pair for this session.
    return undefined;
  }
  return normalizedLower === "openai-codex" ? "openai" : normalized;
}

// Modern Codex models (gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.2) use the
// none/low/medium/high/xhigh effort enum and reject "minimal". The CLI
// defaults thinkLevel to "minimal", so without translation EVERY agent turn
// on those models pays a wasted first request + retry-with-low fallback in
// pi-embedded-runner. Map "minimal" -> "low" upfront for modern models so the
// first request is accepted. Older Codex models still accept "minimal"
// directly. (#71946)
// Exported for unit-test coverage of the model-aware translation path.
export function resolveReasoningEffort(
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"],
  modelId: string,
): "minimal" | "low" | "medium" | "high" | "xhigh" | null {
  if (thinkLevel === "minimal") {
    return isModernCodexModel(modelId) ? "low" : "minimal";
  }
  if (
    thinkLevel === "low" ||
    thinkLevel === "medium" ||
    thinkLevel === "high" ||
    thinkLevel === "xhigh"
  ) {
    return thinkLevel;
  }
  return null;
}
