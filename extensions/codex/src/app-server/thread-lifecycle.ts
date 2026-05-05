import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY,
  renderCodexPromptOverlay,
} from "../../prompt-overlay.js";
import { isModernCodexModel } from "../../provider.js";
import { isCodexAppServerConnectionClosedError, type CodexAppServerClient } from "./client.js";
import { codexSandboxPolicyForTurn, type CodexAppServerRuntimeOptions } from "./config.js";
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
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

export async function startOrResumeThread(params: {
  client: CodexAppServerClient;
  params: EmbeddedRunAttemptParams;
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  config?: JsonObject;
}): Promise<CodexAppServerThreadBinding> {
  const dynamicToolsFingerprint = fingerprintDynamicTools(params.dynamicTools);
  const binding = await readCodexAppServerBinding(params.params.sessionFile, {
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    config: params.params.config,
  });
  let preserveExistingBinding = false;
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
        const response = assertCodexThreadResumeResponse(
          await params.client.request(
            "thread/resume",
            buildThreadResumeParams(params.params, {
              threadId: binding.threadId,
              authProfileId,
              appServer: params.appServer,
              developerInstructions: params.developerInstructions,
              config: params.config,
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
        await writeCodexAppServerBinding(
          params.params.sessionFile,
          {
            threadId: response.thread.id,
            cwd: params.cwd,
            authProfileId: boundAuthProfileId,
            model: params.params.modelId,
            modelProvider: response.modelProvider ?? fallbackModelProvider,
            dynamicToolsFingerprint,
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

  const response = assertCodexThreadStartResponse(
    await params.client.request(
      "thread/start",
      buildThreadStartParams(params.params, {
        cwd: params.cwd,
        dynamicTools: params.dynamicTools,
        appServer: params.appServer,
        developerInstructions: params.developerInstructions,
        config: params.config,
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
    createdAt,
    updatedAt: createdAt,
  };
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
    ...(options.config ? { config: options.config } : {}),
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
    ...(options.config ? { config: options.config } : {}),
    developerInstructions: options.developerInstructions ?? buildDeveloperInstructions(params),
    persistExtendedHistory: true,
  };
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
      developer_instructions:
        params.trigger === "heartbeat" ? buildHeartbeatCollaborationInstructions() : null,
    },
  };
}

function buildHeartbeatCollaborationInstructions(): string {
  return [
    "This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake; ordinary chat turns should stay in Codex Default mode.",
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
    "You are running inside OpenClaw. Use OpenClaw dynamic tools for OpenClaw-specific integrations such as messaging, cron, sessions, media, gateway, and nodes when available.",
    "Preserve the user's existing channel/session context. If sending a channel reply, use the OpenClaw messaging tool instead of describing that you would reply.",
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

function resolveCodexAppServerModelProvider(params: {
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
