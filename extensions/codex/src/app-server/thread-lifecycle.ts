import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { renderCodexPromptOverlay } from "../../prompt-overlay.js";
import { isModernCodexModel } from "../../provider.js";
import type { CodexAppServerClient } from "./client.js";
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
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
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
  const binding = await readCodexAppServerBinding(params.params.sessionFile);
  if (binding?.threadId) {
    // `/codex resume <thread>` writes a binding before the next turn can know
    // the dynamic tool catalog, so only invalidate fingerprints we actually have.
    if (
      binding.dynamicToolsFingerprint &&
      binding.dynamicToolsFingerprint !== dynamicToolsFingerprint
    ) {
      embeddedAgentLog.debug(
        "codex app-server dynamic tool catalog changed; starting a new thread",
        {
          threadId: binding.threadId,
        },
      );
      await clearCodexAppServerBinding(params.params.sessionFile);
    } else {
      try {
        const response = assertCodexThreadResumeResponse(
          await params.client.request(
            "thread/resume",
            buildThreadResumeParams(params.params, {
              threadId: binding.threadId,
              appServer: params.appServer,
              developerInstructions: params.developerInstructions,
              config: params.config,
            }),
          ),
        );
        const boundAuthProfileId = params.params.authProfileId ?? binding.authProfileId;
        const fallbackModelProvider = resolveCodexAppServerModelProvider(params.params.provider);
        await writeCodexAppServerBinding(params.params.sessionFile, {
          threadId: response.thread.id,
          cwd: params.cwd,
          authProfileId: boundAuthProfileId,
          model: params.params.modelId,
          modelProvider: response.modelProvider ?? fallbackModelProvider,
          dynamicToolsFingerprint,
          createdAt: binding.createdAt,
        });
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
        embeddedAgentLog.warn("codex app-server thread resume failed; starting a new thread", {
          error,
        });
        await clearCodexAppServerBinding(params.params.sessionFile);
      }
    }
  }

  const modelProvider = resolveCodexAppServerModelProvider(params.params.provider);
  const response = assertCodexThreadStartResponse(
    await params.client.request("thread/start", {
      model: params.params.modelId,
      ...(modelProvider ? { modelProvider } : {}),
      cwd: params.cwd,
      approvalPolicy: params.appServer.approvalPolicy,
      approvalsReviewer: params.appServer.approvalsReviewer,
      sandbox: params.appServer.sandbox,
      ...(params.appServer.serviceTier ? { serviceTier: params.appServer.serviceTier } : {}),
      serviceName: "OpenClaw",
      ...(params.config ? { config: params.config } : {}),
      developerInstructions:
        params.developerInstructions ?? buildDeveloperInstructions(params.params),
      dynamicTools: params.dynamicTools,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    } satisfies CodexThreadStartParams),
  );
  const createdAt = new Date().toISOString();
  await writeCodexAppServerBinding(params.params.sessionFile, {
    threadId: response.thread.id,
    cwd: params.cwd,
    authProfileId: params.params.authProfileId,
    model: response.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? modelProvider,
    dynamicToolsFingerprint,
    createdAt,
  });
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

export function buildThreadResumeParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    appServer: CodexAppServerRuntimeOptions;
    developerInstructions?: string;
    config?: JsonObject;
  },
): CodexThreadResumeParams {
  const modelProvider = resolveCodexAppServerModelProvider(params.provider);
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
  };
}

function fingerprintDynamicTools(dynamicTools: CodexDynamicToolSpec[]): string {
  return JSON.stringify(dynamicTools.map(fingerprintDynamicToolSpec));
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

export function buildDeveloperInstructions(params: EmbeddedRunAttemptParams): string {
  const promptOverlay = renderCodexRuntimePromptOverlay(params);
  const sections = [
    "You are running inside OpenClaw. Use OpenClaw dynamic tools for messaging, cron, sessions, and host actions when available.",
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

function resolveCodexAppServerModelProvider(provider: string): string | undefined {
  const normalized = provider.trim();
  if (!normalized || normalized === "codex") {
    // `codex` is OpenClaw's virtual provider; let Codex app-server keep its
    // native provider/auth selection instead of forcing the legacy OpenAI path.
    return undefined;
  }
  return normalized === "openai-codex" ? "openai" : normalized;
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
