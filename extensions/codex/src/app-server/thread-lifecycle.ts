import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { renderCodexPromptOverlay } from "../../prompt-overlay.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import {
  isJsonObject,
  type CodexThreadResumeParams,
  type CodexThreadResumeResponse,
  type CodexThreadStartResponse,
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
  dynamicTools: JsonValue[];
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
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
        const response = await params.client.request<CodexThreadResumeResponse>(
          "thread/resume",
          buildThreadResumeParams(params.params, {
            threadId: binding.threadId,
            appServer: params.appServer,
            developerInstructions: params.developerInstructions,
          }),
        );
        const boundAuthProfileId = params.params.authProfileId ?? binding.authProfileId;
        await writeCodexAppServerBinding(params.params.sessionFile, {
          threadId: response.thread.id,
          cwd: params.cwd,
          authProfileId: boundAuthProfileId,
          model: params.params.modelId,
          modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
          dynamicToolsFingerprint,
          createdAt: binding.createdAt,
        });
        return {
          ...binding,
          threadId: response.thread.id,
          cwd: params.cwd,
          authProfileId: boundAuthProfileId,
          model: params.params.modelId,
          modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
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

  const response = await params.client.request<CodexThreadStartResponse>("thread/start", {
    model: params.params.modelId,
    modelProvider: normalizeModelProvider(params.params.provider),
    cwd: params.cwd,
    approvalPolicy: params.appServer.approvalPolicy,
    approvalsReviewer: params.appServer.approvalsReviewer,
    sandbox: params.appServer.sandbox,
    ...(params.appServer.serviceTier ? { serviceTier: params.appServer.serviceTier } : {}),
    serviceName: "OpenClaw",
    developerInstructions:
      params.developerInstructions ?? buildDeveloperInstructions(params.params),
    dynamicTools: params.dynamicTools,
    experimentalRawEvents: true,
    persistExtendedHistory: true,
  });
  const createdAt = new Date().toISOString();
  await writeCodexAppServerBinding(params.params.sessionFile, {
    threadId: response.thread.id,
    cwd: params.cwd,
    authProfileId: params.params.authProfileId,
    model: response.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
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
    modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
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
  },
): CodexThreadResumeParams {
  return {
    threadId: options.threadId,
    model: params.modelId,
    modelProvider: normalizeModelProvider(params.provider),
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    sandbox: options.appServer.sandbox,
    ...(options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {}),
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
    model: params.modelId,
    ...(options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {}),
    effort: resolveReasoningEffort(params.thinkLevel),
  };
}

function fingerprintDynamicTools(dynamicTools: JsonValue[]): string {
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
  const sections = [
    "You are running inside OpenClaw. Use OpenClaw dynamic tools for messaging, cron, sessions, and host actions when available.",
    "Preserve the user's existing channel/session context. If sending a channel reply, use the OpenClaw messaging tool instead of describing that you would reply.",
    renderCodexPromptOverlay({ modelId: params.modelId }),
    params.extraSystemPrompt,
    params.skillsSnapshot?.prompt,
  ];
  return sections.filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}

function buildUserInput(
  params: EmbeddedRunAttemptParams,
  promptText: string = params.prompt,
): CodexUserInput[] {
  return [
    { type: "text", text: promptText },
    ...(params.images ?? []).map(
      (image): CodexUserInput => ({
        type: "image",
        url: `data:${image.mimeType};base64,${image.data}`,
      }),
    ),
  ];
}

function normalizeModelProvider(provider: string): string {
  return provider === "codex" || provider === "openai-codex" ? "openai" : provider;
}

function resolveReasoningEffort(
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"],
): "minimal" | "low" | "medium" | "high" | "xhigh" | null {
  if (
    thinkLevel === "minimal" ||
    thinkLevel === "low" ||
    thinkLevel === "medium" ||
    thinkLevel === "high" ||
    thinkLevel === "xhigh"
  ) {
    return thinkLevel;
  }
  return null;
}
