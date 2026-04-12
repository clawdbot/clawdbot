import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;

type AcpSpawnModule = typeof import("../acp-spawn.js");

let acpSpawnModulePromise: Promise<AcpSpawnModule> | undefined;

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  acpSpawnModulePromise ??= import("../acp-spawn.js");
  return await acpSpawnModulePromise;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing agent session by its ID (e.g. a Codex session UUID from ~/.codex/sessions/). Requires runtime="acp". The agent replays conversation history via session/load instead of starting fresh.',
    }),
  ),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
  streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS),
  lightContext: Type.Optional(
    Type.Boolean({
      description:
        "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
    }),
  ),

  // Inline attachments (snapshot-by-value).
  // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        content: Type.String(),
        encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
        mimeType: Type.Optional(Type.String()),
      }),
      { maxItems: 50 },
    ),
  ),
  attachAs: Type.Optional(
    Type.Object({
      // Where the spawned agent should look for attachments.
      // Kept as a hint; implementation materializes into the child workspace.
      mountPath: Type.Optional(Type.String()),
    }),
  ),
});

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool(),
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const task = readStringParam(params, "task", { required: true });
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      if (streamTo && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `streamTo is only supported for runtime=acp; got runtime=${runtime}`,
        });
      }

      if (resumeSessionId && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `resumeSessionId is only supported for runtime=acp; got runtime=${runtime}`,
        });
      }

      if (runtime === "acp") {
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            streamTo,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            sandboxed: opts?.sandboxed,
          },
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        const shouldTrackViaRegistry =
          result.status === "accepted" &&
          Boolean(childSessionKey) &&
          Boolean(childRunId) &&
          streamTo !== "parent";
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = loadConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
          const { mainKey, alias } = resolveMainSessionAlias(cfg);
          const requesterInternalKey = opts?.agentSessionKey
            ? resolveInternalSessionKey({
                key: opts.agentSessionKey,
                alias,
                mainKey,
              })
            : alias;
          const requesterDisplayKey = resolveDisplaySessionKey({
            key: requesterInternalKey,
            alias,
            mainKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          try {
            registerSubagentRun({
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
              requesterOrigin,
              requesterDisplayKey,
              task,
              cleanup: trackedCleanup,
              label: label || undefined,
              runTimeoutSeconds,
              expectsCompletionMessage,
              spawnMode: trackedSpawnMode,
            });
          } catch (err) {
            // Best-effort only: the ACP turn was already started above, so deleting the
            // child session record here does not guarantee the in-flight run was aborted.
            await cleanupUntrackedAcpSession(childSessionKey);
            return jsonResult({
              status: "error",
              error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
              childSessionKey,
              runId: childRunId,
            });
          }
        }
        return jsonResult(result);
      }

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          sandbox,
          lightContext,
          expectsCompletionMessage,
          attachments,
          attachMountPath:
            params.attachAs && typeof params.attachAs === "object"
              ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
              : undefined,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
        },
      );

      return jsonResult(result);
    },
  };
}
