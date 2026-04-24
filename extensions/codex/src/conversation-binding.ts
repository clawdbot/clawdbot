import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  PluginConversationBindingResolvedEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  codexSandboxPolicyForTurn,
  resolveCodexAppServerRuntimeOptions,
} from "./app-server/config.js";
import {
  type CodexThreadResumeResponse,
  type CodexThreadStartResponse,
  type CodexTurnStartResponse,
  type JsonValue,
} from "./app-server/protocol.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import { getSharedCodexAppServerClient } from "./app-server/shared-client.js";
import {
  createCodexConversationBindingData,
  readCodexConversationBindingData,
  readCodexConversationBindingDataRecord,
  resolveCodexDefaultWorkspaceDir,
  type CodexConversationBindingData,
} from "./conversation-binding-data.js";
import { trackCodexConversationActiveTurn } from "./conversation-control.js";
import { createCodexConversationTurnCollector } from "./conversation-turn-collector.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

const DEFAULT_BOUND_TURN_TIMEOUT_MS = 20 * 60_000;

export {
  createCodexConversationBindingData,
  readCodexConversationBindingData,
  readCodexConversationBindingDataRecord,
  resolveCodexDefaultWorkspaceDir,
  type CodexConversationBindingData,
} from "./conversation-binding-data.js";

type CodexConversationRunOptions = {
  pluginConfig?: unknown;
  timeoutMs?: number;
};

type CodexConversationStartParams = {
  pluginConfig?: unknown;
  sessionFile: string;
  workspaceDir?: string;
  threadId?: string;
  model?: string;
  modelProvider?: string;
};

type BoundTurnResult = {
  reply: ReplyPayload;
};

type CodexConversationGlobalState = {
  queues: Map<string, Promise<void>>;
};

const CODEX_CONVERSATION_GLOBAL_STATE = Symbol.for("openclaw.codex.conversationBinding");

function getGlobalState(): CodexConversationGlobalState {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_CONVERSATION_GLOBAL_STATE]?: CodexConversationGlobalState;
  };
  globalState[CODEX_CONVERSATION_GLOBAL_STATE] ??= { queues: new Map() };
  return globalState[CODEX_CONVERSATION_GLOBAL_STATE];
}

export async function startCodexConversationThread(
  params: CodexConversationStartParams,
): Promise<CodexConversationBindingData> {
  const workspaceDir =
    params.workspaceDir?.trim() || resolveCodexDefaultWorkspaceDir(params.pluginConfig);
  if (params.threadId?.trim()) {
    await attachExistingThread({
      pluginConfig: params.pluginConfig,
      sessionFile: params.sessionFile,
      threadId: params.threadId.trim(),
      workspaceDir,
      model: params.model,
      modelProvider: params.modelProvider,
    });
  } else {
    await createThread({
      pluginConfig: params.pluginConfig,
      sessionFile: params.sessionFile,
      workspaceDir,
      model: params.model,
      modelProvider: params.modelProvider,
    });
  }
  return createCodexConversationBindingData({
    sessionFile: params.sessionFile,
    workspaceDir,
  });
}

export async function handleCodexConversationInboundClaim(
  event: PluginHookInboundClaimEvent,
  ctx: PluginHookInboundClaimContext,
  options: CodexConversationRunOptions = {},
): Promise<{ handled: boolean; reply?: ReplyPayload } | undefined> {
  const data = readCodexConversationBindingData(ctx.pluginBinding);
  if (!data) {
    return undefined;
  }
  const prompt = (event.bodyForAgent ?? event.content ?? "").trim();
  if (!prompt) {
    return { handled: true };
  }
  try {
    const result = await enqueueBoundTurn(data.sessionFile, () =>
      runBoundTurn({
        data,
        prompt,
        event,
        pluginConfig: options.pluginConfig,
        timeoutMs: options.timeoutMs,
      }),
    );
    return { handled: true, reply: result.reply };
  } catch (error) {
    return {
      handled: true,
      reply: {
        text: `Codex app-server turn failed: ${formatErrorMessage(error)}`,
      },
    };
  }
}

export async function handleCodexConversationBindingResolved(
  event: PluginConversationBindingResolvedEvent,
): Promise<void> {
  if (event.status !== "denied") {
    return;
  }
  const data = readCodexConversationBindingDataRecord(event.request.data ?? {});
  if (!data) {
    return;
  }
  await clearCodexAppServerBinding(data.sessionFile);
}

async function attachExistingThread(params: {
  pluginConfig?: unknown;
  sessionFile: string;
  threadId: string;
  workspaceDir: string;
  model?: string;
  modelProvider?: string;
}): Promise<void> {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
  });
  const response: CodexThreadResumeResponse = await client.request(
    CODEX_CONTROL_METHODS.resumeThread,
    {
      threadId: params.threadId,
      ...(params.model ? { model: params.model } : {}),
      ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
      approvalPolicy: runtime.approvalPolicy,
      approvalsReviewer: runtime.approvalsReviewer,
      sandbox: runtime.sandbox,
      ...(runtime.serviceTier ? { serviceTier: runtime.serviceTier } : {}),
      persistExtendedHistory: true,
    },
    { timeoutMs: runtime.requestTimeoutMs },
  );
  const thread = response.thread;
  await writeCodexAppServerBinding(params.sessionFile, {
    threadId: thread.id,
    cwd: thread.cwd ?? params.workspaceDir,
    model: response.model ?? params.model,
    modelProvider: response.modelProvider ?? params.modelProvider,
    approvalPolicy: runtime.approvalPolicy,
    sandbox: runtime.sandbox,
    serviceTier: runtime.serviceTier,
  });
}

async function createThread(params: {
  pluginConfig?: unknown;
  sessionFile: string;
  workspaceDir: string;
  model?: string;
  modelProvider?: string;
}): Promise<void> {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
  });
  const response: CodexThreadStartResponse = await client.request(
    "thread/start",
    {
      cwd: params.workspaceDir,
      ...(params.model ? { model: params.model } : {}),
      ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
      approvalPolicy: runtime.approvalPolicy,
      approvalsReviewer: runtime.approvalsReviewer,
      sandbox: runtime.sandbox,
      ...(runtime.serviceTier ? { serviceTier: runtime.serviceTier } : {}),
      developerInstructions:
        "This Codex thread is bound to an OpenClaw conversation. Answer normally; OpenClaw will deliver your final response back to the conversation.",
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    },
    { timeoutMs: runtime.requestTimeoutMs },
  );
  await writeCodexAppServerBinding(params.sessionFile, {
    threadId: response.thread.id,
    cwd: response.thread.cwd ?? params.workspaceDir,
    model: response.model ?? params.model,
    modelProvider: response.modelProvider ?? params.modelProvider,
    approvalPolicy: runtime.approvalPolicy,
    sandbox: runtime.sandbox,
    serviceTier: runtime.serviceTier,
  });
}

async function runBoundTurn(params: {
  data: CodexConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  pluginConfig?: unknown;
  timeoutMs?: number;
}): Promise<BoundTurnResult> {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const binding = await readCodexAppServerBinding(params.data.sessionFile);
  const threadId = binding?.threadId;
  if (!threadId) {
    throw new Error("bound Codex conversation has no thread binding");
  }

  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: binding.authProfileId,
  });
  const collector = createCodexConversationTurnCollector(threadId);
  const notificationCleanup = client.addNotificationHandler((notification) =>
    collector.handleNotification(notification),
  );
  const requestCleanup = client.addRequestHandler(
    async (request): Promise<JsonValue | undefined> => {
      if (request.method === "item/tool/call") {
        return {
          contentItems: [
            {
              type: "inputText",
              text: "OpenClaw native Codex conversation binding does not expose dynamic OpenClaw tools yet.",
            },
          ],
          success: false,
        };
      }
      if (
        request.method === "item/commandExecution/requestApproval" ||
        request.method === "item/fileChange/requestApproval"
      ) {
        return {
          decision: "decline",
          reason:
            "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.",
        };
      }
      if (request.method === "item/permissions/requestApproval") {
        return { permissions: {}, scope: "turn" };
      }
      if (request.method.includes("requestApproval")) {
        return {
          decision: "decline",
          reason:
            "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.",
        };
      }
      return undefined;
    },
  );
  try {
    const response: CodexTurnStartResponse = await client.request(
      "turn/start",
      {
        threadId,
        input: buildCodexConversationTurnInput({ prompt: params.prompt, event: params.event }),
        cwd: binding.cwd || params.data.workspaceDir,
        approvalPolicy: binding.approvalPolicy ?? runtime.approvalPolicy,
        approvalsReviewer: runtime.approvalsReviewer,
        sandboxPolicy: codexSandboxPolicyForTurn(
          binding.sandbox ?? runtime.sandbox,
          binding.cwd || params.data.workspaceDir,
        ),
        ...(binding.model ? { model: binding.model } : {}),
        ...((binding.serviceTier ?? runtime.serviceTier)
          ? { serviceTier: binding.serviceTier ?? runtime.serviceTier }
          : {}),
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
    const turnId = response.turn.id;
    const activeCleanup = trackCodexConversationActiveTurn({
      sessionFile: params.data.sessionFile,
      threadId,
      turnId,
    });
    collector.setTurnId(turnId);
    const completion = await collector
      .wait({
        timeoutMs: params.timeoutMs ?? DEFAULT_BOUND_TURN_TIMEOUT_MS,
      })
      .finally(activeCleanup);
    const replyText = completion.replyText.trim();
    return {
      reply: {
        text: replyText || "Codex completed without a text reply.",
      },
    };
  } finally {
    notificationCleanup();
    requestCleanup();
  }
}

function enqueueBoundTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
  const state = getGlobalState();
  const previous = state.queues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const queued = next.then(
    () => undefined,
    () => undefined,
  );
  state.queues.set(key, queued);
  void next.finally(() => {
    if (state.queues.get(key) === queued) {
      state.queues.delete(key);
    }
  });
  return next;
}

export const __testing = {
  resetQueues() {
    getGlobalState().queues.clear();
  },
};
