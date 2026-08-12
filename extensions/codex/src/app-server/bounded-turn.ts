import fs from "node:fs/promises";
import path from "node:path";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import {
  CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  interruptCodexTurnAndWaitBestEffort,
} from "./attempt-client-cleanup.js";
import {
  isRetryableErrorNotification,
  isTerminalTurnStatus,
  readCodexNotificationItem,
} from "./attempt-notifications.js";
import type { CodexAppServerAuthRequirement, CodexAppServerPreparedAuth } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { normalizeCodexResponseTokenUsage } from "./event-projector-usage.js";
import { readModelListResult } from "./models.js";
import { readCodexNotificationTurnId } from "./notification-correlation.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import {
  assertCodexThreadStartResponse,
  assertCodexTurnStartResponse,
  readCodexErrorNotification,
  readCodexTurnCompletedNotification,
} from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadItem,
  type CodexThreadStartParams,
  type CodexTurn,
  type CodexTurnStartParams,
  type CodexUserInput,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import {
  isCodexAppServerStartSelectionChangedError,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { buildCodexRuntimeThreadConfig } from "./thread-lifecycle.js";
import {
  assertCodexRestrictedToolSurfaceHasNoManagedHooks,
  attestCodexRestrictedToolSurfaceMcpServersDisabled,
  buildCodexRingZeroThreadConfigPatch,
  readCodexInheritedMcpServerNames,
} from "./thread-requests.js";

const CODEX_APP_SERVER_ARGS_ENV_KEY = "OPENCLAW_CODEX_APP_SERVER_ARGS";
const CODEX_BOUNDED_THREAD_CONFIG: JsonObject = {
  "agents.enabled": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.apps": false,
  "features.plugins": false,
  "features.image_generation": false,
  "features.standalone_web_search": false,
  web_search: "disabled",
};
const CODEX_PRIVATE_BOUNDED_THREAD_CONFIG: JsonObject = {
  "features.hooks": false,
  notify: [],
};
const CODEX_SETTLED_FINALIZER_THREAD_CONFIG: JsonObject = {
  "skills.include_instructions": false,
  include_environment_context: false,
};

export type CodexBoundedTurnOptions = {
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
};

type CodexBoundedTurnResult = {
  text: string;
  items: CodexThreadItem[];
  model: string;
  usage?: ReturnType<typeof normalizeCodexResponseTokenUsage>;
};

type CodexBoundedTurnModelSelection = { mode: "required"; id: string } | { mode: "live-default" };

class CodexBoundedTurnTimeoutError extends Error {
  override name = "TimeoutError";

  constructor(taskLabel: string, timeoutMs: number) {
    const bound = timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
    super(`codex app-server ${taskLabel} turn timed out after ${bound}`);
  }
}

type CodexBoundedTurnParams = {
  config?: OpenClawConfig;
  model: CodexBoundedTurnModelSelection;
  modelProvider?: string;
  profile?: string;
  preparedAuth?: CodexAppServerPreparedAuth;
  authRequirement?: CodexAppServerAuthRequirement;
  timeoutMs: number;
  signal?: AbortSignal;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  options: CodexBoundedTurnOptions;
  taskLabel: string;
  developerInstructions: string;
  input: CodexUserInput[];
  requiredModalities: string[];
  isolation: "configured-transport" | "private-stdio";
  threadConfig?: JsonObject;
  historyItems?: JsonValue[];
  requireNoExternalCapabilities?: boolean;
  /** Finalizer-only: preserve a completed turn whose protocol carries no answer item. */
  allowEmptyText?: boolean;
};

export async function runBoundedCodexAppServerTurn(
  params: CodexBoundedTurnParams,
): Promise<CodexBoundedTurnResult> {
  const appServer = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.options.pluginConfig,
    managedCommandOrder: params.isolation === "private-stdio" ? "package-first" : undefined,
  });
  if (params.isolation === "configured-transport") {
    return await runBoundedCodexAppServerTurnInWorkspace(params, appServer, {
      cwd: params.agentDir?.trim() || process.cwd(),
    });
  }
  if (appServer.start.transport !== "stdio") {
    throw new Error("Bounded Codex turns require stdio transport so native tools can be isolated.");
  }
  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "codex-bounded-turn-",
    },
    async (workspace) => {
      const codexHome = path.join(workspace.dir, "codex-home");
      const cwd = path.join(workspace.dir, "workspace");
      await Promise.all([
        fs.mkdir(codexHome, { recursive: true }),
        fs.mkdir(cwd, { recursive: true }),
      ]);
      return await runBoundedCodexAppServerTurnInWorkspace(params, appServer, { codexHome, cwd });
    },
  );
}

async function runBoundedCodexAppServerTurnInWorkspace(
  params: CodexBoundedTurnParams,
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
  workspace: { codexHome?: string; cwd: string },
  selectionAttempt = 0,
  timing?: { deadline: number; timeoutMs: number },
): Promise<CodexBoundedTurnResult> {
  const totalTimeoutMs = timing?.timeoutMs ?? resolveTimerTimeoutMs(params.timeoutMs, 100, 100);
  const timeoutError = new CodexBoundedTurnTimeoutError(params.taskLabel, totalTimeoutMs);
  const deadline = timing?.deadline ?? Date.now() + totalTimeoutMs;
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) {
    throw timeoutError;
  }
  const agentDir = params.agentDir?.trim() || undefined;
  // Hosted search needs a private Codex home and cwd so inherited native tools
  // cannot escape the bounded turn. Media calls retain configured transport
  // compatibility while still using an isolated ephemeral thread.
  const isolatedStartOptions = workspace.codexHome
    ? buildPrivateCodexAppServerStartOptions(appServer.start, workspace.codexHome)
    : appServer.start;
  // A prepared credential is scoped to the fresh private home even when the
  // operator's configured app-server normally points at their user home.
  const startOptions =
    workspace.codexHome && params.preparedAuth
      ? { ...isolatedStartOptions, homeScope: "agent" as const }
      : isolatedStartOptions;
  const ownsClient = !params.options.clientFactory;
  const authSelection = params.preparedAuth
    ? { preparedAuth: params.preparedAuth }
    : { authProfileId: params.profile };
  const client = params.options.clientFactory
    ? await params.options.clientFactory({
        startOptions,
        ...authSelection,
        authRequirement: params.authRequirement,
        agentDir,
        config: params.config,
        timeoutMs,
        ...(params.signal ? { abandonSignal: params.signal } : {}),
      })
    : await import("./shared-client.js").then(({ createIsolatedCodexAppServerClient }) =>
        createIsolatedCodexAppServerClient({
          startOptions,
          timeoutMs,
          ...authSelection,
          authRequirement: params.authRequirement,
          agentDir,
          authProfileStore: params.authProfileStore,
          config: params.config,
          ...(params.signal ? { abandonSignal: params.signal } : {}),
        }),
      );
  const abortController = new AbortController();
  let activeThreadId: string | undefined;
  let activeTurnId = "";
  let interruptPromise: Promise<boolean> | undefined;
  const requestInterrupt = () => {
    if (!activeThreadId || interruptPromise) {
      return;
    }
    // Codex serializes start/interrupt per thread; an empty turn id is its
    // explicit startup-interrupt contract while turn/start is still resolving.
    interruptPromise = interruptCodexTurnAndWaitBestEffort(client, {
      threadId: activeThreadId,
      turnId: activeTurnId,
      timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    });
  };
  const abortRun = (reason: unknown) => {
    abortController.abort(reason);
    requestInterrupt();
  };
  const abortFromCaller = () => abortRun(params.signal?.reason ?? "aborted");
  if (params.signal?.aborted) {
    abortFromCaller();
  } else {
    params.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const remainingRunMs = deadline - Date.now();
  if (remainingRunMs <= 0) {
    abortRun(timeoutError);
  }
  const timeout = setTimeout(() => abortRun(timeoutError), Math.max(1, remainingRunMs));
  timeout.unref?.();

  let retrySelection = false;
  try {
    const model = await resolveCodexBoundedTurnModel({
      client,
      selection: params.model,
      requiredModalities: params.requiredModalities,
      timeoutMs,
      signal: abortController.signal,
    });
    const inheritedMcpServerNames = params.requireNoExternalCapabilities
      ? await readCodexInheritedMcpServerNames(client, workspace.cwd, abortController.signal)
      : [];
    if (params.requireNoExternalCapabilities) {
      await assertCodexRestrictedToolSurfaceHasNoManagedHooks(client, abortController.signal);
    }
    const threadConfig = buildCodexRuntimeThreadConfig(
      resolveBoundedThreadConfig(params, workspace, inheritedMcpServerNames),
      { nativeCodeModeEnabled: false },
    );
    const thread = assertCodexThreadStartResponse(
      await client.request<unknown>(
        "thread/start",
        {
          model,
          ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
          cwd: workspace.cwd,
          approvalPolicy: "on-request",
          sandbox: "read-only",
          serviceName: "OpenClaw",
          ...(params.requireNoExternalCapabilities ? { baseInstructions: "" } : {}),
          developerInstructions: params.developerInstructions,
          config: threadConfig,
          environments: [],
          dynamicTools: [],
          experimentalRawEvents: true,
          ephemeral: true,
        } satisfies CodexThreadStartParams,
        { timeoutMs, signal: abortController.signal },
      ),
    );
    activeThreadId = thread.thread.id;
    if (abortController.signal.aborted) {
      requestInterrupt();
    }
    if (params.requireNoExternalCapabilities) {
      // Attest the started thread before injecting historical tool evidence.
      // Otherwise inherited MCP state could act on a finalization-only turn.
      await attestCodexRestrictedToolSurfaceMcpServersDisabled(
        client,
        thread.thread.id,
        threadConfig,
        abortController.signal,
      );
    }
    if (params.historyItems?.length) {
      await client.request(
        "thread/inject_items",
        { threadId: thread.thread.id, items: params.historyItems },
        { timeoutMs, signal: abortController.signal },
      );
    }
    const collector = createCodexBoundedTurnCollector(
      thread.thread.id,
      params.taskLabel,
      params.allowEmptyText === true,
    );
    const cleanup = client.addNotificationHandler(collector.handleNotification);
    const requestCleanup = client.addRequestHandler(
      createCodexBoundedApprovalHandler(params.taskLabel),
    );
    try {
      const turn = assertCodexTurnStartResponse(
        // Inherit the empty thread environment; a cwd override recreates native tools.
        await client.request<unknown>(
          "turn/start",
          {
            threadId: thread.thread.id,
            input: params.input,
            approvalPolicy: "on-request",
            model,
            effort: "low",
          } satisfies CodexTurnStartParams,
          { timeoutMs, signal: abortController.signal },
        ),
      );
      activeTurnId = turn.turn.id;
      if (abortController.signal.aborted) {
        requestInterrupt();
      }
      return {
        ...(await collector.collect(turn.turn, {
          signal: abortController.signal,
          timeoutError,
        })),
        model,
      };
    } finally {
      await interruptPromise;
      requestCleanup();
      cleanup();
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw resolveCodexBoundedTurnAbortError(
        abortController.signal,
        params.taskLabel,
        timeoutError,
      );
    }
    if (ownsClient && isCodexAppServerStartSelectionChangedError(error) && selectionAttempt === 0) {
      retrySelection = true;
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromCaller);
    await interruptPromise;
    if (ownsClient) {
      await closeCodexStartupClientBestEffort(client);
    }
  }
  if (retrySelection) {
    return await runBoundedCodexAppServerTurnInWorkspace(
      params,
      appServer,
      workspace,
      selectionAttempt + 1,
      { deadline, timeoutMs: totalTimeoutMs },
    );
  }
  throw new Error("Codex bounded turn selection retry exited unexpectedly");
}

function resolveBoundedThreadConfig(
  params: CodexBoundedTurnParams,
  workspace: { codexHome?: string },
  inheritedMcpServerNames: readonly string[],
): JsonObject {
  const boundedConfig =
    mergeCodexThreadConfigs(CODEX_BOUNDED_THREAD_CONFIG, params.threadConfig) ??
    CODEX_BOUNDED_THREAD_CONFIG;
  const privateConfig = workspace.codexHome
    ? (mergeCodexThreadConfigs(boundedConfig, CODEX_PRIVATE_BOUNDED_THREAD_CONFIG) ?? boundedConfig)
    : boundedConfig;
  if (!params.requireNoExternalCapabilities) {
    return privateConfig;
  }
  return (
    mergeCodexThreadConfigs(
      privateConfig,
      CODEX_SETTLED_FINALIZER_THREAD_CONFIG,
      buildCodexRingZeroThreadConfigPatch(
        { toolsAllow: ["openclaw"] },
        true,
        inheritedMcpServerNames,
      ),
    ) ?? privateConfig
  );
}

function buildPrivateCodexAppServerStartOptions(
  start: ReturnType<typeof resolveCodexAppServerRuntimeOptions>["start"],
  codexHome: string,
): ReturnType<typeof resolveCodexAppServerRuntimeOptions>["start"] {
  // Provider identity and model catalogs must survive isolation; hooks, MCP,
  // sandbox policy, and other process overrides must not cross that boundary.
  const providerArgs = start.args.flatMap((arg, index) => {
    const override =
      arg === "-c" || arg === "--config"
        ? start.args[index + 1]
        : arg.startsWith("--config=")
          ? arg.slice("--config=".length)
          : undefined;
    return override && /^\s*(?:openai_base_url|model_catalog_json)\s*=/u.test(override)
      ? ["-c", override]
      : [];
  });
  const privateEnv = Object.fromEntries(
    Object.entries(start.env ?? {}).filter(
      ([name]) => name.trim().toUpperCase() !== CODEX_APP_SERVER_ARGS_ENV_KEY,
    ),
  );
  const clearEnv = (start.clearEnv ?? []).filter((name) => {
    const normalized = name.trim().toUpperCase();
    return normalized !== "CODEX_HOME" && normalized !== CODEX_APP_SERVER_ARGS_ENV_KEY;
  });
  return {
    ...start,
    args: ["app-server", ...providerArgs, "--listen", "stdio://"],
    env: {
      ...privateEnv,
      CODEX_HOME: codexHome,
    },
    clearEnv: [...clearEnv, CODEX_APP_SERVER_ARGS_ENV_KEY],
  };
}

function createCodexBoundedApprovalHandler(taskLabel: string) {
  return (request: { method: string }): JsonValue | undefined => {
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval"
    ) {
      return {
        decision: "decline",
        reason: `OpenClaw Codex ${taskLabel} does not grant tool or file approvals.`,
      };
    }
    if (request.method === "item/permissions/requestApproval") {
      return { permissions: {}, scope: "turn" };
    }
    if (request.method.includes("requestApproval")) {
      return {
        decision: "decline",
        reason: `OpenClaw Codex ${taskLabel} does not grant native approvals.`,
      };
    }
    if (request.method === "mcpServer/elicitation/request") {
      return { action: "decline" };
    }
    return undefined;
  };
}

async function resolveCodexBoundedTurnModel(params: {
  client: CodexAppServerClient;
  selection: CodexBoundedTurnModelSelection;
  requiredModalities: string[];
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  const result = await params.client.request<unknown>(
    "model/list",
    { limit: null, cursor: null, includeHidden: false },
    { timeoutMs: Math.min(params.timeoutMs, 5_000), signal: params.signal },
  );
  const listed = readModelListResult(result).models;
  if (params.selection.mode === "live-default") {
    const supported = listed.filter((entry) =>
      params.requiredModalities.every((modality) => entry.inputModalities.includes(modality)),
    );
    const selected = supported.find((entry) => entry.isDefault) ?? supported[0];
    if (!selected) {
      throw new Error(
        `Codex app-server has no model supporting ${params.requiredModalities.join(" and ")} input.`,
      );
    }
    return selected.model;
  }

  const model = params.selection.id;
  const match = listed.find((entry) => entry.model === model || entry.id === model);
  if (!match) {
    throw new Error(`Codex app-server model not found: ${model}`);
  }
  if (params.requiredModalities.includes("image") && !match.inputModalities.includes("image")) {
    throw new Error(`Codex app-server model does not support images: ${model}`);
  }
  if (params.requiredModalities.includes("text") && !match.inputModalities.includes("text")) {
    throw new Error(`Codex app-server model does not support text: ${model}`);
  }
  return model;
}

function createCodexBoundedTurnCollector(
  threadId: string,
  taskLabel: string,
  allowEmptyText: boolean,
) {
  let turnId: string | undefined;
  let completedTurn: CodexTurn | undefined;
  let promptError: string | undefined;
  let responseUsage: ReturnType<typeof normalizeCodexResponseTokenUsage>;
  const pending: CodexServerNotification[] = [];
  const completedItems = new Map<string, CodexThreadItem>();
  const assistantTextByItem = new Map<string, string>();
  const assistantItemOrder: string[] = [];
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const rememberAssistantText = (itemId: string, text: string) => {
    if (!text) {
      return;
    }
    if (!assistantTextByItem.has(itemId)) {
      assistantItemOrder.push(itemId);
    }
    assistantTextByItem.set(itemId, text);
  };

  const handleNotification = (notification: CodexServerNotification): void => {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || readString(params, "threadId") !== threadId) {
      return;
    }
    if (!turnId) {
      pending.push(notification);
      return;
    }
    if (readCodexNotificationTurnId(params) !== turnId) {
      return;
    }
    if (notification.method === "item/completed") {
      const item = readCodexNotificationItem(notification.params);
      if (item) {
        completedItems.set(item.id, item);
        if (item.type === "agentMessage" && typeof item.text === "string") {
          rememberAssistantText(item.id, item.text);
        }
      }
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
      const delta = readString(params, "delta") ?? "";
      rememberAssistantText(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
      return;
    }
    if (notification.method === "rawResponse/completed") {
      const usage = isJsonObject(params.usage) ? params.usage : undefined;
      // Exact per-response usage replaces any earlier response in this turn.
      responseUsage = usage ? normalizeCodexResponseTokenUsage(usage) : undefined;
      return;
    }
    if (notification.method === "turn/completed") {
      completedTurn =
        readCodexTurnCompletedNotification(notification.params)?.turn ?? completedTurn;
      resolveCompletion?.();
      return;
    }
    if (notification.method === "error") {
      if (isRetryableErrorNotification(notification.params)) {
        return;
      }
      promptError =
        readCodexErrorNotification(notification.params)?.error.message ??
        `codex app-server ${taskLabel} turn failed`;
      resolveCompletion?.();
    }
  };

  return {
    handleNotification,
    async collect(
      startedTurn: CodexTurn,
      options: { signal: AbortSignal; timeoutError: CodexBoundedTurnTimeoutError },
    ): Promise<Omit<CodexBoundedTurnResult, "model">> {
      turnId = startedTurn.id;
      if (isTerminalTurnStatus(startedTurn.status)) {
        completedTurn = startedTurn;
      }
      for (const notification of pending.splice(0)) {
        handleNotification(notification);
      }
      if (!completedTurn && !promptError) {
        await waitForTurnCompletion({
          completion,
          signal: options.signal,
          taskLabel,
          timeoutError: options.timeoutError,
        });
      }
      if (promptError) {
        throw new Error(promptError);
      }
      if (completedTurn?.status === "failed") {
        throw new Error(
          completedTurn.error?.message ?? `codex app-server ${taskLabel} turn failed`,
        );
      }
      if (completedTurn?.status !== "completed") {
        throw new Error(
          `codex app-server ${taskLabel} turn ended with status ${completedTurn?.status ?? "unknown"}`,
        );
      }
      const items = collectCompletedItems(completedTurn?.items, completedItems);
      const itemText = collectAssistantTextFromItems(items);
      const deltaText = assistantItemOrder
        .map((itemId) => assistantTextByItem.get(itemId)?.trim())
        .filter((text): text is string => Boolean(text))
        .join("\n\n")
        .trim();
      const text = (itemText || deltaText).trim();
      if (!text && !allowEmptyText) {
        throw new Error(`Codex app-server ${taskLabel} turn returned no text.`);
      }
      return { text, items, ...(responseUsage ? { usage: responseUsage } : {}) };
    },
  };
}

function collectCompletedItems(
  turnItems: CodexThreadItem[] | undefined,
  notificationItems: Map<string, CodexThreadItem>,
): CodexThreadItem[] {
  const items = new Map(notificationItems);
  for (const item of turnItems ?? []) {
    items.set(item.id, item);
  }
  return [...items.values()];
}

async function waitForTurnCompletion(params: {
  completion: Promise<void>;
  signal: AbortSignal;
  taskLabel: string;
  timeoutError: CodexBoundedTurnTimeoutError;
}): Promise<void> {
  if (params.signal.aborted) {
    throw resolveCodexBoundedTurnAbortError(params.signal, params.taskLabel, params.timeoutError);
  }
  let cleanupAbort: (() => void) | undefined;
  try {
    await Promise.race([
      params.completion,
      new Promise<never>((_, reject) => {
        const abortListener = () =>
          reject(
            resolveCodexBoundedTurnAbortError(params.signal, params.taskLabel, params.timeoutError),
          );
        params.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = () => params.signal.removeEventListener("abort", abortListener);
      }),
    ]);
  } finally {
    cleanupAbort?.();
  }
}

function resolveCodexBoundedTurnAbortError(
  signal: AbortSignal,
  taskLabel: string,
  timeoutError: CodexBoundedTurnTimeoutError,
): Error {
  // Only this owner can classify its deadline as a timeout. Caller cancellation
  // reasons remain behind the established Error-shaped aborted-turn boundary.
  return signal.reason === timeoutError
    ? timeoutError
    : new Error(`codex app-server ${taskLabel} turn aborted`);
}

function collectAssistantTextFromItems(items: CodexThreadItem[] | undefined): string {
  return (items ?? [])
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
