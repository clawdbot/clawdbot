import fs from "node:fs/promises";
import path from "node:path";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import {
  isRetryableErrorNotification,
  readCodexNotificationItem,
} from "./attempt-notifications.js";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { normalizeCodexResponseTokenUsage } from "./event-projector-usage.js";
import { readModelListResult } from "./models.js";
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
  assertCodexRingZeroHasNoManagedHooks,
  attestCodexRingZeroThreadHasNoMcpServers,
  buildCodexRingZeroThreadConfigPatch,
  readCodexInheritedMcpServerNames,
} from "./thread-requests.js";

const CODEX_PRIVATE_STDIO_ARGS = ["app-server", "--listen", "stdio://"];
const CODEX_APP_SERVER_ARGS_ENV_KEY = "OPENCLAW_CODEX_APP_SERVER_ARGS";
const CODEX_BOUNDED_THREAD_CONFIG: JsonObject = {
  "features.multi_agent": false,
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

type CodexBoundedTurnParams = {
  config?: OpenClawConfig;
  model: CodexBoundedTurnModelSelection;
  profile?: string;
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
  const deadline = timing?.deadline ?? Date.now() + totalTimeoutMs;
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) {
    throw new Error(`${params.taskLabel} timed out`);
  }
  const agentDir = params.agentDir?.trim() || undefined;
  // Hosted search needs a private Codex home and cwd so inherited native tools
  // cannot escape the bounded turn. Media calls retain configured transport
  // compatibility while still using an isolated ephemeral thread.
  const startOptions = workspace.codexHome
    ? buildPrivateCodexAppServerStartOptions(appServer.start, workspace.codexHome)
    : appServer.start;
  const ownsClient = !params.options.clientFactory;
  const client = params.options.clientFactory
    ? await params.options.clientFactory({
        startOptions,
        authProfileId: params.profile,
        agentDir,
        config: params.config,
        timeoutMs,
      })
    : await import("./shared-client.js").then(({ createIsolatedCodexAppServerClient }) =>
        createIsolatedCodexAppServerClient({
          startOptions,
          timeoutMs,
          authProfileId: params.profile,
          agentDir,
          authProfileStore: params.authProfileStore,
          config: params.config,
        }),
      );
  const abortController = new AbortController();
  const abortFromCaller = () => abortController.abort(params.signal?.reason ?? "aborted");
  if (params.signal?.aborted) {
    abortFromCaller();
  } else {
    params.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const remainingRunMs = deadline - Date.now();
  if (remainingRunMs <= 0) {
    abortController.abort("timeout");
  }
  const timeout = setTimeout(() => abortController.abort("timeout"), Math.max(1, remainingRunMs));
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
      await assertCodexRingZeroHasNoManagedHooks(client, abortController.signal);
    }
    const thread = assertCodexThreadStartResponse(
      await client.request<unknown>(
        "thread/start",
        {
          model,
          modelProvider: "openai",
          cwd: workspace.cwd,
          approvalPolicy: "on-request",
          sandbox: "read-only",
          serviceName: "OpenClaw",
          ...(params.requireNoExternalCapabilities ? { baseInstructions: "" } : {}),
          developerInstructions: params.developerInstructions,
          config: buildCodexRuntimeThreadConfig(
            resolveBoundedThreadConfig(params, workspace, inheritedMcpServerNames),
            { nativeCodeModeEnabled: false },
          ),
          environments: [],
          dynamicTools: [],
          experimentalRawEvents: true,
          ephemeral: true,
        } satisfies CodexThreadStartParams,
        { timeoutMs, signal: abortController.signal },
      ),
    );
    if (params.requireNoExternalCapabilities) {
      // Attest the started thread before injecting historical tool evidence.
      // Otherwise inherited MCP state could act on a finalization-only turn.
      await attestCodexRingZeroThreadHasNoMcpServers(
        client,
        thread.thread.id,
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
    const collector = createCodexBoundedTurnCollector(thread.thread.id, params.taskLabel);
    const cleanup = client.addNotificationHandler(collector.handleNotification);
    const requestCleanup = client.addRequestHandler(
      createCodexBoundedApprovalHandler(params.taskLabel),
    );
    try {
      const turn = assertCodexTurnStartResponse(
        await client.request<unknown>(
          "turn/start",
          {
            threadId: thread.thread.id,
            input: params.input,
            cwd: workspace.cwd,
            approvalPolicy: "on-request",
            model,
            effort: "low",
          } satisfies CodexTurnStartParams,
          { timeoutMs, signal: abortController.signal },
        ),
      );
      return {
        ...(await collector.collect(turn.turn, {
          timeoutMs,
          signal: abortController.signal,
        })),
        model,
      };
    } finally {
      requestCleanup();
      cleanup();
    }
  } catch (error) {
    if (ownsClient && isCodexAppServerStartSelectionChangedError(error) && selectionAttempt === 0) {
      retrySelection = true;
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromCaller);
    if (ownsClient) {
      client.close();
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
    args: [...CODEX_PRIVATE_STDIO_ARGS],
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

function createCodexBoundedTurnCollector(threadId: string, taskLabel: string) {
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
    const notificationTurnId = readNotificationTurnId(params);
    if (notificationTurnId !== turnId) {
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
      options: { timeoutMs: number; signal: AbortSignal },
    ): Promise<Omit<CodexBoundedTurnResult, "model">> {
      turnId = startedTurn.id;
      if (isTerminalTurn(startedTurn)) {
        completedTurn = startedTurn;
      }
      for (const notification of pending.splice(0)) {
        handleNotification(notification);
      }
      if (!completedTurn && !promptError) {
        await waitForTurnCompletion({
          completion,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          taskLabel,
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
      if (!text) {
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
  timeoutMs: number;
  signal: AbortSignal;
  taskLabel: string;
}): Promise<void> {
  if (params.signal.aborted) {
    throw new Error(`codex app-server ${params.taskLabel} turn aborted`);
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleanupAbort: (() => void) | undefined;
  try {
    await Promise.race([
      params.completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`codex app-server ${params.taskLabel} turn timed out`)),
          params.timeoutMs,
        );
        timeout.unref?.();
        const abortListener = () =>
          reject(new Error(`codex app-server ${params.taskLabel} turn aborted`));
        params.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = () => params.signal.removeEventListener("abort", abortListener);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    cleanupAbort?.();
  }
}

function collectAssistantTextFromItems(items: CodexThreadItem[] | undefined): string {
  return (items ?? [])
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function readNotificationTurnId(record: JsonObject): string | undefined {
  const direct = readString(record, "turnId");
  if (direct) {
    return direct;
  }
  return isJsonObject(record.turn) ? readString(record.turn, "id") : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isTerminalTurn(turn: CodexTurn): boolean {
  return turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed";
}
