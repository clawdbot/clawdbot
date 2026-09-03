import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { hasGatewayAdminScope } from "./chat-origin-routing.js";
import { buildRestartSafeChatTranscriptState } from "./chat-restart-recovery.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import {
  resolveChatSendReplyContext,
  type ChatSendReplyContextFields,
} from "./chat-send-reply-context.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { gatewayClientSenderFields } from "./gateway-client-identity.js";
import type { GatewayClient } from "./shared-types.js";

type GatewayChatUserTurnController = {
  baseInput: UserTurnInput;
  persist: ReturnType<typeof createUserTurnTranscriptRecorder>["persistFallback"];
  persistBestEffort: () => Promise<void>;
  recorder: UserTurnTranscriptRecorder;
  replyContextFieldsPromise?: Promise<ChatSendReplyContextFields>;
  setInputPromise: (input: Promise<UserTurnInput>) => void;
};

export function createGatewayChatUserTurnController(params: {
  admission: AdmittedChatSend;
  client: GatewayClient | null;
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  transcript?: Pick<UserTurnInput, "display" | "excludeFromContext">;
  startedAt: number;
  warn: (message: string) => void;
  assertGoalCurrent?: () => void;
}): GatewayChatUserTurnController {
  const { admission, request, session } = params;
  const sender =
    request.goalOperation?.action === "resume"
      ? undefined
      : gatewayClientSenderFields(params.client).sender;
  const baseInput: UserTurnInput = {
    ...params.transcript,
    ...(request.goalOperation?.action === "resume" ? { display: false } : {}),
    text: request.rawMessage,
    timestamp: session.now,
    idempotencyKey: buildRunUserTurnIdempotencyKey(session.clientRunId),
    ...(request.p.replyToId ? { replyToId: request.p.replyToId } : {}),
    ...(sender ? { sender } : {}),
    ...(hasGatewayAdminScope(params.client) ? { senderIsOwner: true } : {}),
    ...(request.systemInputProvenance ? { provenance: request.systemInputProvenance } : {}),
  };
  const replyContextFieldsPromise = request.p.replyToId
    ? resolveChatSendReplyContext({
        replyToId: request.p.replyToId,
        cfg: session.cfg,
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        sessionEntry: session.entry,
        storePath: session.storePath,
        userSenderLabel: request.clientInfo?.displayName,
        warn: params.warn,
      })
    : undefined;
  let inputPromise = replyContextFieldsPromise
    ? replyContextFieldsPromise.then(
        (fields): UserTurnInput => ({
          ...baseInput,
          ...(fields.ReplyToBody
            ? {
                replyToPreview: {
                  text: fields.ReplyToBody,
                  ...(fields.ReplyToSender ? { senderLabel: fields.ReplyToSender } : {}),
                },
              }
            : {}),
        }),
      )
    : Promise.resolve(baseInput);
  const recorder = createUserTurnTranscriptRecorder({
    ...(request.goalOperation
      ? {
          sessionTurnMutation: {
            kind: "goal",
            operation: request.goalOperation,
            runId: session.clientRunId,
            assertCurrent: params.assertGoalCurrent,
          },
        }
      : {}),
    input: baseInput,
    resolveInput: () => inputPromise,
    target: () => {
      // Retain only the current binding; transcript writers recheck it at commit.
      const { storePath, entry } = loadSessionEntry(session.sessionKey, {
        ...session.sessionLoadOptions,
        clone: false,
      });
      const sessionId = (entry ?? admission.initialSessionEntry)?.sessionId;
      if (!sessionId || sessionId !== admission.sessionBinding.sessionId) {
        return undefined;
      }
      return {
        sessionId,
        expectedSessionId: sessionId,
        initialSessionEntry: admission.initialSessionEntry,
        sessionKey: session.sessionKey,
        sessionEntry: undefined,
        storePath,
        agentId: session.agentId,
        config: session.cfg,
      };
    },
    ...(admission.restartSafeAdmission
      ? buildRestartSafeChatTranscriptState({
          admission: admission.restartSafeAdmission,
          clientRunId: session.clientRunId,
          startedAt: params.startedAt,
        })
      : {}),
    errorContext: "gateway chat user turn transcript",
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    onPersistenceError: (error) =>
      params.warn(`gateway user transcript persistence failed: ${formatForLog(error)}`),
  });
  const persist = async () =>
    await measureDiagnosticsTimelineSpan(
      "gateway.chat_send.persist_user_transcript",
      () => recorder.persistFallback(),
      {
        phase: "agent-turn",
        config: session.cfg,
        attributes: admission.chatSendTraceAttributes,
      },
    );
  return {
    baseInput,
    persist,
    persistBestEffort: async () => {
      await persist().catch(() => undefined);
    },
    recorder,
    replyContextFieldsPromise,
    setInputPromise: (input) => {
      const previousInputPromise = inputPromise;
      inputPromise = Promise.all([previousInputPromise, input]).then(([previous, next]) => ({
        ...previous,
        ...next,
      }));
    },
  };
}
