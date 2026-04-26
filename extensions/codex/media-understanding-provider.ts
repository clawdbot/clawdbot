import {
  type ImagesDescriptionRequest,
  type ImagesDescriptionResult,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { CODEX_PROVIDER_ID, FALLBACK_CODEX_MODELS } from "./provider-catalog.js";
import { type CodexAppServerClientFactory } from "./src/app-server/client-factory.js";
import type { CodexAppServerClient } from "./src/app-server/client.js";
import { resolveCodexAppServerRuntimeOptions } from "./src/app-server/config.js";
import { readModelListResult } from "./src/app-server/models.js";
import {
  assertCodexThreadStartResponse,
  assertCodexTurnStartResponse,
  readCodexErrorNotification,
  readCodexTurnCompletedNotification,
} from "./src/app-server/protocol-validators.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadItem,
  type CodexThreadStartParams,
  type CodexTurn,
  type CodexTurnStartParams,
  type JsonObject,
  type JsonValue,
} from "./src/app-server/protocol.js";

const DEFAULT_CODEX_IMAGE_MODEL =
  FALLBACK_CODEX_MODELS.find((model) => model.inputModalities.includes("image"))?.id ??
  FALLBACK_CODEX_MODELS[0]?.id;
const DEFAULT_CODEX_IMAGE_PROMPT = "Describe the image.";

export type CodexMediaUnderstandingProviderOptions = {
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
};

export function buildCodexMediaUnderstandingProvider(
  options: CodexMediaUnderstandingProviderOptions = {},
): MediaUnderstandingProvider {
  return {
    id: CODEX_PROVIDER_ID,
    capabilities: ["image"],
    ...(DEFAULT_CODEX_IMAGE_MODEL ? { defaultModels: { image: DEFAULT_CODEX_IMAGE_MODEL } } : {}),
    describeImage: async (req) =>
      describeCodexImages(
        {
          images: [
            {
              buffer: req.buffer,
              fileName: req.fileName,
              mime: req.mime,
            },
          ],
          provider: req.provider,
          model: req.model,
          prompt: req.prompt,
          maxTokens: req.maxTokens,
          timeoutMs: req.timeoutMs,
          profile: req.profile,
          preferredProfile: req.preferredProfile,
          authStore: req.authStore,
          agentDir: req.agentDir,
          cfg: req.cfg,
        },
        options,
      ),
    describeImages: async (req) => describeCodexImages(req, options),
  };
}

async function describeCodexImages(
  req: ImagesDescriptionRequest,
  options: CodexMediaUnderstandingProviderOptions,
): Promise<ImagesDescriptionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Codex image understanding requires model id.");
  }

  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const timeoutMs = Math.max(100, req.timeoutMs);
  const ownsClient = !options.clientFactory;
  const client = options.clientFactory
    ? await options.clientFactory(appServer.start, req.profile)
    : await import("./src/app-server/shared-client.js").then(
        ({ createIsolatedCodexAppServerClient }) =>
          createIsolatedCodexAppServerClient({
            startOptions: appServer.start,
            timeoutMs,
            authProfileId: req.profile,
          }),
      );
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);
  timeout.unref?.();

  try {
    await assertCodexModelSupportsImage({
      client,
      model,
      timeoutMs,
      signal: abortController.signal,
    });
    const thread = assertCodexThreadStartResponse(
      await client.request<unknown>(
        "thread/start",
        {
          model,
          modelProvider: "openai",
          cwd: req.agentDir || process.cwd(),
          approvalPolicy: "on-request",
          sandbox: "read-only",
          serviceName: "OpenClaw",
          developerInstructions:
            "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
          dynamicTools: [],
          experimentalRawEvents: true,
          persistExtendedHistory: false,
          ephemeral: true,
        } satisfies CodexThreadStartParams,
        { timeoutMs, signal: abortController.signal },
      ),
    );
    const collector = createCodexImageTurnCollector(thread.thread.id);
    const cleanup = client.addNotificationHandler(collector.handleNotification);
    const requestCleanup = client.addRequestHandler(denyCodexImageApprovalRequest);
    try {
      const turn = assertCodexTurnStartResponse(
        await client.request<unknown>(
          "turn/start",
          {
            threadId: thread.thread.id,
            input: [
              { type: "text", text: buildCodexImagePrompt(req), text_elements: [] },
              ...req.images.map((image) => ({
                type: "image" as const,
                url: `data:${image.mime ?? "image/png"};base64,${image.buffer.toString("base64")}`,
              })),
            ],
            cwd: req.agentDir || process.cwd(),
            approvalPolicy: "on-request",
            model,
            effort: "low",
          } satisfies CodexTurnStartParams,
          { timeoutMs, signal: abortController.signal },
        ),
      );
      const text = await collector.collect(turn.turn, {
        timeoutMs,
        signal: abortController.signal,
      });
      return { text, model };
    } finally {
      requestCleanup();
      cleanup();
    }
  } finally {
    clearTimeout(timeout);
    if (ownsClient) {
      client.close();
    }
  }
}

function denyCodexImageApprovalRequest(request: { method: string }): JsonValue | undefined {
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    return {
      decision: "decline",
      reason: "OpenClaw Codex image understanding does not grant tool or file approvals.",
    };
  }
  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (request.method.includes("requestApproval")) {
    return {
      decision: "decline",
      reason: "OpenClaw Codex image understanding does not grant native approvals.",
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return { action: "decline" };
  }
  return undefined;
}

async function assertCodexModelSupportsImage(params: {
  client: CodexAppServerClient;
  model: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const result = await params.client.request<unknown>(
    "model/list",
    { limit: 100, cursor: null, includeHidden: false },
    { timeoutMs: Math.min(params.timeoutMs, 5_000), signal: params.signal },
  );
  const listed = readModelListResult(result).models;
  const match = listed.find((entry) => entry.model === params.model || entry.id === params.model);
  if (!match) {
    throw new Error(`Codex app-server model not found: ${params.model}`);
  }
  if (!match.inputModalities.includes("image")) {
    throw new Error(`Codex app-server model does not support images: ${params.model}`);
  }
}

function buildCodexImagePrompt(req: ImagesDescriptionRequest): string {
  const prompt = req.prompt?.trim() || DEFAULT_CODEX_IMAGE_PROMPT;
  if (req.images.length <= 1) {
    return prompt;
  }
  return `${prompt}\n\nAnalyze all ${req.images.length} images together.`;
}

function createCodexImageTurnCollector(threadId: string) {
  let turnId: string | undefined;
  let completedTurn: CodexTurn | undefined;
  let promptError: string | undefined;
  const pending: CodexServerNotification[] = [];
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
    if (notification.method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
      const delta = readString(params, "delta") ?? "";
      rememberAssistantText(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
      return;
    }
    if (notification.method === "turn/completed") {
      completedTurn =
        readCodexTurnCompletedNotification(notification.params)?.turn ?? completedTurn;
      resolveCompletion?.();
      return;
    }
    if (notification.method === "error") {
      promptError =
        readCodexErrorNotification(notification.params)?.error.message ??
        "codex app-server image turn failed";
      resolveCompletion?.();
    }
  };

  return {
    handleNotification,
    async collect(
      startedTurn: CodexTurn,
      options: { timeoutMs: number; signal: AbortSignal },
    ): Promise<string> {
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
        });
      }
      if (promptError) {
        throw new Error(promptError);
      }
      if (completedTurn?.status === "failed") {
        throw new Error(completedTurn.error?.message ?? "codex app-server image turn failed");
      }
      const itemText = collectAssistantTextFromItems(completedTurn?.items);
      const deltaText = assistantItemOrder
        .map((itemId) => assistantTextByItem.get(itemId)?.trim())
        .filter((text): text is string => Boolean(text))
        .join("\n\n")
        .trim();
      const text = (itemText || deltaText).trim();
      if (!text) {
        throw new Error("Codex app-server image turn returned no text.");
      }
      return text;
    },
  };
}

async function waitForTurnCompletion(params: {
  completion: Promise<void>;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleanupAbort: (() => void) | undefined;
  try {
    await Promise.race([
      params.completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("codex app-server image turn timed out")),
          params.timeoutMs,
        );
        timeout.unref?.();
        const abortListener = () => reject(new Error("codex app-server image turn aborted"));
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
