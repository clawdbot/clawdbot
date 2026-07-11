/**
 * Owner-only access to native Codex threads stored in the user's Codex home.
 */
import path from "node:path";
import {
  jsonResult,
  readStringParam,
  type AnyAgentTool,
  type PluginRuntime,
} from "openclaw/plugin-sdk/core";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "openclaw/plugin-sdk/model-session-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  readCodexPluginConfig,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./app-server/config.js";
import {
  CODEX_INTERACTIVE_THREAD_SOURCE_KINDS,
  isJsonObject,
  type JsonValue,
} from "./app-server/protocol.js";
import {
  assertCodexBindingMayBeReplaced,
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
} from "./app-server/session-binding.js";
import { assertCodexArchiveDescendantsUnowned } from "./app-server/thread-archive-guard.js";
import { codexControlRequest, type CodexControlRequestOptions } from "./command-rpc.js";

const ListParamsSchema = Type.Object(
  {
    action: Type.Literal("list"),
    archived: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    search: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ReadParamsSchema = Type.Object(
  {
    action: Type.Literal("read"),
    thread_id: Type.String(),
    include_turns: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ForkParamsSchema = Type.Object(
  {
    action: Type.Literal("fork"),
    thread_id: Type.String(),
    attach: Type.Optional(
      Type.Boolean({
        default: true,
        description: "Attach the fork to this OpenClaw session for its next turn.",
      }),
    ),
  },
  { additionalProperties: false },
);

const RenameParamsSchema = Type.Object(
  {
    action: Type.Literal("rename"),
    thread_id: Type.String(),
    name: Type.String(),
  },
  { additionalProperties: false },
);

const ArchiveParamsSchema = Type.Object(
  {
    action: Type.Literal("archive"),
    thread_id: Type.String(),
    confirm: Type.Literal(true, {
      description: "Required acknowledgement that the thread is closed in other Codex clients.",
    }),
  },
  { additionalProperties: false },
);

const UnarchiveParamsSchema = Type.Object(
  {
    action: Type.Literal("unarchive"),
    thread_id: Type.String(),
  },
  { additionalProperties: false },
);

const CodexThreadsParamsSchema = Type.Union([
  ListParamsSchema,
  ReadParamsSchema,
  ForkParamsSchema,
  RenameParamsSchema,
  ArchiveParamsSchema,
  UnarchiveParamsSchema,
]);

type CodexThreadsToolOptions = {
  bindingStore: CodexAppServerBindingStore;
  context: OpenClawPluginToolContext;
  runtime: PluginRuntime;
  getPluginConfig: () => unknown;
  request?: typeof codexControlRequest;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : undefined;
}

function resolveToolSession(
  context: OpenClawPluginToolContext,
  runtime: PluginRuntime,
): { sessionId: string; sessionFile: string; modelSelectionLocked: boolean } | undefined {
  const sessionKey = context.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const entry = runtime.agent.session.getSessionEntry({
    agentId: context.agentId,
    sessionKey,
    readConsistency: "latest",
  });
  const sessionId = context.sessionId?.trim() || entry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  const storePath = runtime.agent.session.resolveStorePath(undefined, {
    agentId: context.agentId,
  });
  return {
    sessionId,
    sessionFile: runtime.agent.session.resolveSessionFilePath(sessionId, entry, {
      agentId: context.agentId,
      sessionsDir: path.dirname(storePath),
    }),
    modelSelectionLocked: isModelSelectionLocked(entry),
  };
}

function readThreadId(params: Record<string, unknown>): string {
  return readStringParam(params, "thread_id", { required: true, label: "thread_id" });
}

function readThreadStatusType(value: unknown): string | undefined {
  if (!isJsonObject(value) || !isJsonObject(value.thread) || !isJsonObject(value.thread.status)) {
    return undefined;
  }
  return typeof value.thread.status.type === "string" ? value.thread.status.type : undefined;
}

function assertThreadMayBeArchived(value: unknown, expectedThreadId: string): void {
  if (!isJsonObject(value) || !isJsonObject(value.thread)) {
    throw new Error("Codex app-server returned an invalid thread/read response");
  }
  if (value.thread.id !== expectedThreadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  const status = readThreadStatusType(value);
  if (status === "active") {
    throw new Error("cannot archive an active Codex thread; wait for its turn to finish");
  }
  if (status !== "idle" && status !== "notLoaded") {
    throw new Error("cannot verify that the Codex thread is idle; refusing to archive");
  }
}

function assertThreadMayBeForked(value: unknown, expectedThreadId: string): void {
  if (!isJsonObject(value) || !isJsonObject(value.thread)) {
    throw new Error("Codex app-server returned an invalid thread/read response");
  }
  if (value.thread.id !== expectedThreadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  const status = readThreadStatusType(value);
  if (status !== "idle" && status !== "notLoaded") {
    throw new Error("cannot fork a Codex thread unless it is idle or not loaded");
  }
}

function redactNativeThreadTranscriptFields(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) {
    return value;
  }
  const redacted = { ...value };
  delete redacted.preview;
  delete redacted.turns;
  return redacted;
}

function redactNativeThreadResponse(value: unknown): unknown {
  if (!isJsonObject(value)) {
    return value;
  }
  const redacted = { ...value };
  if (Array.isArray(redacted.data)) {
    redacted.data = redacted.data.map(redactNativeThreadTranscriptFields);
  }
  if (isJsonObject(redacted.thread)) {
    redacted.thread = redactNativeThreadTranscriptFields(redacted.thread);
  }
  return redacted;
}

/** Builds the native Codex thread tool only for owner runs with native-home access. */
export function createCodexThreadsTool(options: CodexThreadsToolOptions): AnyAgentTool | null {
  if (options.context.senderIsOwner !== true) {
    return null;
  }
  const configured = readCodexPluginConfig(options.getPluginConfig());
  if (configured.appServer?.homeScope !== "user" && configured.supervision?.enabled !== true) {
    return null;
  }
  const request = options.request ?? codexControlRequest;
  const runtimeConfig = () =>
    options.context.getRuntimeConfig?.() ?? options.context.runtimeConfig ?? options.context.config;
  const baseRequestOptions = (): CodexControlRequestOptions => ({
    agentDir: options.context.agentDir,
    config: runtimeConfig(),
    sessionId: options.context.sessionId,
    sessionKey: options.context.sessionKey,
  });
  const currentSession = () => resolveToolSession(options.context, options.runtime);
  const currentIdentity = (sessionId: string) =>
    sessionBindingIdentity({
      sessionId,
      sessionKey: options.context.sessionKey,
      agentId: options.context.agentId,
      config: runtimeConfig(),
    });
  const currentBinding = async (session: ReturnType<typeof currentSession>) =>
    session ? await options.bindingStore.read(currentIdentity(session.sessionId)) : undefined;
  const requestOptions = async (pluginConfig: unknown): Promise<CodexControlRequestOptions> => {
    const plugin = readCodexPluginConfig(pluginConfig);
    const session = currentSession();
    const binding = await currentBinding(session);
    if (binding?.connectionScope === "supervision") {
      const connection = resolveCodexBindingAppServerConnection({ binding, pluginConfig });
      return {
        ...baseRequestOptions(),
        startOptions: connection.appServer.start,
        authProfileId: connection.clientAuthProfileId,
      };
    }
    if (plugin.appServer?.homeScope === "user") {
      const connection = resolveCodexBindingAppServerConnection({ binding, pluginConfig });
      return {
        ...baseRequestOptions(),
        startOptions: connection.appServer.start,
        authProfileId: null,
      };
    }
    if (plugin.supervision?.enabled !== true) {
      throw new Error("Codex native thread access is disabled for this run.");
    }
    return {
      ...baseRequestOptions(),
      startOptions: resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig }).start,
      authProfileId: null,
    };
  };

  return {
    name: "codex_threads",
    label: "Codex Threads",
    description:
      "List and inspect native Codex threads. When supervision is enabled, raw transcript reads and every mutation require their matching supervision policy option.",
    parameters: CodexThreadsParamsSchema,
    async execute(_toolCallId, rawParams) {
      const params = asRecord(rawParams);
      const action = readStringParam(params, "action", { required: true, label: "action" });
      const pluginConfig = options.getPluginConfig();
      const plugin = readCodexPluginConfig(pluginConfig);
      const supervision = plugin.supervision;
      const mayReadRawTranscripts =
        supervision?.enabled !== true || supervision.allowRawTranscripts === true;

      if (action === "list") {
        const cursor = readStringParam(params, "cursor");
        const searchTerm = readStringParam(params, "search");
        if (searchTerm && !mayReadRawTranscripts) {
          throw new Error(
            "Codex native thread search is disabled while raw transcript access is disabled.",
          );
        }
        const response = await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.listThreads,
          {
            archived: readBoolean(params.archived),
            limit: readLimit(params.limit) ?? 20,
            modelProviders: [],
            sortKey: "recency_at",
            sortDirection: "desc",
            sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
            ...(cursor ? { cursor } : {}),
            ...(searchTerm ? { searchTerm } : {}),
          },
          await requestOptions(pluginConfig),
        );
        return jsonResult(mayReadRawTranscripts ? response : redactNativeThreadResponse(response));
      }

      const threadId = readThreadId(params);
      if (action === "read") {
        const includeTurns = readBoolean(params.include_turns);
        if (includeTurns && !mayReadRawTranscripts) {
          throw new Error(
            "Codex raw transcript reads are disabled for this codex plugin supervision config.",
          );
        }
        const response = await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.readThread,
          { threadId, includeTurns },
          await requestOptions(pluginConfig),
        );
        return jsonResult(mayReadRawTranscripts ? response : redactNativeThreadResponse(response));
      }
      const isMutation =
        action === "fork" || action === "rename" || action === "archive" || action === "unarchive";
      if (isMutation && supervision?.enabled === true && supervision.allowWriteControls !== true) {
        throw new Error(
          "Codex native thread mutations are disabled for this codex plugin supervision config.",
        );
      }
      if (action === "rename") {
        const name = readStringParam(params, "name", { required: true, label: "name" });
        await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.renameThread,
          { threadId, name },
          await requestOptions(pluginConfig),
        );
        return jsonResult({ action, threadId, name });
      }
      if (action === "unarchive") {
        const response = await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.unarchiveThread,
          { threadId },
          await requestOptions(pluginConfig),
        );
        return jsonResult(mayReadRawTranscripts ? response : redactNativeThreadResponse(response));
      }

      const session = currentSession();
      const binding = await currentBinding(session);
      if (action === "archive") {
        if (params.confirm !== true) {
          throw new Error("confirm=true is required to archive a native Codex thread");
        }
        if (!session) {
          throw new Error("cannot safely archive a native Codex thread without a session identity");
        }
        const identity = currentIdentity(session.sessionId);
        await options.bindingStore.withThreadArchiveFence(async () => {
          const archivedBinding = await currentBinding(session);
          if (archivedBinding?.threadId === threadId) {
            // Clearing the binding detaches the harness-owned Codex thread. The session lock keeps
            // both that thread and App Server-selected model routing fixed.
            if (session.modelSelectionLocked) {
              throw new ModelSelectionLockedError();
            }
            assertCodexBindingMayBeReplaced(archivedBinding, "archiving its bound native thread");
          }
          // App Server status is process-local, and archive is a separate RPC. This read blocks
          // known active/invalid state; `confirm` owns the remaining cross-client race.
          const current = await request(
            pluginConfig,
            CODEX_CONTROL_METHODS.readThread,
            { threadId, includeTurns: false },
            await requestOptions(pluginConfig),
          );
          assertThreadMayBeArchived(current, threadId);
          if (await options.bindingStore.hasOtherThreadOwner(threadId, identity)) {
            throw new Error(
              "cannot archive a native Codex thread owned by another OpenClaw session",
            );
          }
          await assertCodexArchiveDescendantsUnowned({
            bindingStore: options.bindingStore,
            threadId,
            listPage: async (listParams) =>
              await request(
                pluginConfig,
                CODEX_CONTROL_METHODS.listThreads,
                listParams,
                await requestOptions(pluginConfig),
              ),
            assertDescendantIdle: async (descendantThreadId) => {
              const descendant = await request(
                pluginConfig,
                CODEX_CONTROL_METHODS.readThread,
                { threadId: descendantThreadId, includeTurns: false },
                await requestOptions(pluginConfig),
              );
              assertThreadMayBeArchived(descendant, descendantThreadId);
            },
          });
          await request(
            pluginConfig,
            CODEX_CONTROL_METHODS.archiveThread,
            { threadId },
            await requestOptions(pluginConfig),
          );
          if (archivedBinding?.threadId === threadId) {
            await options.bindingStore.mutate(identity, {
              kind: "clear",
              threadId,
            });
          }
        });
        return jsonResult({ action, threadId });
      }
      if (action !== "fork") {
        throw new Error(`unsupported codex_threads action: ${action}`);
      }

      const attach = readBoolean(params.attach, true);
      if (attach && !session) {
        throw new Error("cannot attach a Codex fork without an active OpenClaw session");
      }
      if (attach && session?.modelSelectionLocked) {
        throw new ModelSelectionLockedError();
      }
      const usesSupervisionConnection =
        binding?.connectionScope === "supervision" ||
        (plugin.appServer?.homeScope !== "user" && supervision?.enabled === true);
      if (attach && usesSupervisionConnection) {
        throw new Error("Supervised Codex forks must stay detached; set attach=false.");
      }
      if (attach) {
        assertCodexBindingMayBeReplaced(binding, "attaching a different native fork");
        // Codex can snapshot an active source as interrupted. Attached forks require a known-safe
        // local status and the exact source identity before App Server may create that snapshot.
        const current = await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.readThread,
          { threadId, includeTurns: false },
          await requestOptions(pluginConfig),
        );
        assertThreadMayBeForked(current, threadId);
      }
      const response = await request(
        pluginConfig,
        CODEX_CONTROL_METHODS.forkThread,
        { threadId, threadSource: "user", excludeTurns: true },
        await requestOptions(pluginConfig),
      );
      if (!isJsonObject(response) || !isJsonObject(response.thread)) {
        throw new Error("Codex app-server returned an invalid thread/fork response");
      }
      const forkThreadId =
        typeof response.thread.id === "string" && response.thread.id.trim()
          ? response.thread.id
          : undefined;
      if (!forkThreadId) {
        throw new Error("Codex app-server thread/fork response did not include a thread id");
      }
      if (attach && session) {
        const attached = await options.bindingStore.mutate(currentIdentity(session.sessionId), {
          kind: "set",
          binding: {
            threadId: forkThreadId,
            cwd:
              typeof response.thread.cwd === "string"
                ? response.thread.cwd
                : (options.context.workspaceDir ?? ""),
            model: typeof response.model === "string" ? response.model : undefined,
            modelProvider:
              typeof response.modelProvider === "string" ? response.modelProvider : undefined,
            historyCoveredThrough: new Date().toISOString(),
          },
        });
        if (!attached) {
          throw new Error("Codex session binding changed before the fork could be attached");
        }
      }
      const result = {
        action,
        sourceThreadId: threadId,
        thread: response.thread,
        attached: attach,
      };
      return jsonResult(mayReadRawTranscripts ? result : redactNativeThreadResponse(result));
    },
  };
}
