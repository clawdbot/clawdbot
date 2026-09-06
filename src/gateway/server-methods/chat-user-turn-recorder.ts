import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type { UserTurnOriginalInputCommit } from "../../sessions/user-turn-transcript.types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { MentionInbox } from "../mention-inbox.types.js";
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
  mentionInbox?: MentionInbox;
  assertGoalCurrent?: () => void;
}): GatewayChatUserTurnController {
  const { admission, request, session } = params;
  const sender =
    request.goalOperation?.action === "resume"
      ? undefined
      : gatewayClientSenderFields(params.client).sender;
  const senderProfileId = params.client?.authenticatedUserProfile?.profileId;
  const selectedMentions = request.mentions;
  const mentionInbox = params.mentionInbox;
  const sourceId = buildRunUserTurnIdempotencyKey(session.clientRunId);
  const baseInput: UserTurnInput = {
    ...params.transcript,
    ...(request.goalOperation?.action === "resume" ? { display: false } : {}),
    text: request.rawMessage,
    ...(request.mentions ? { mentions: request.mentions } : {}),
    timestamp: session.now,
    idempotencyKey: sourceId,
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
    ? replyContextFieldsPromise.then((fields): UserTurnInput => ({
        ...baseInput,
        ...(fields.ReplyToBody
          ? {
              replyToPreview: {
                text: fields.ReplyToBody,
                ...(fields.ReplyToSender ? { senderLabel: fields.ReplyToSender } : {}),
              },
            }
          : {}),
      }))
    : Promise.resolve(baseInput);
  const recorder = createUserTurnTranscriptRecorder({
    ...(sender?.id && !request.goalOperation
      ? {
          // Attribution and submitted bytes survive reconnect; display names, leaf
          // cursors and generated media paths are not immutable request identity.
          pendingInputRequestFingerprint: createHash("sha256")
            .update(
              stableStringify([
                {
                  ...request.p,
                  sessionId: admission.sessionBinding.sessionId,
                  expectedLeafEntryId: undefined,
                },
                sender.identity ?? sender.id,
                hasGatewayAdminScope(params.client),
              ]),
            )
            .digest("hex"),
        }
      : {}),
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
    ...(selectedMentions && senderProfileId && mentionInbox
      ? {
          onOriginalInputCommitted: ({ message, anchor }: UserTurnOriginalInputCommit) => {
            const stored = message["__openclaw"]?.humanMentions;
            const text =
              extractTextFromChatContent(message.content, {
                joinWith: "\n",
                normalizeText: (value) => value,
              }) ?? "";
            const retained = selectedMentions.filter(
              (mention) =>
                Array.isArray(stored) &&
                stored.some((value) => {
                  const span = asOptionalRecord(value);
                  return (
                    span?.profileId === mention.profileId &&
                    span.start === mention.start &&
                    span.end === mention.end &&
                    text.slice(mention.start, mention.end) ===
                      request.rawMessage.slice(mention.start, mention.end)
                  );
                }),
            );
            if (!retained.length) {
              params.warn(
                "Human mentions skipped because the committed text no longer contains the selected tokens.",
              );
              return;
            }
            mentionInbox.recordCommittedInput({
              sourceId,
              agentId: anchor.agentId,
              sessionKey: session.sessionKey,
              sessionId: anchor.sessionId,
              messageId: anchor.entryId,
              senderProfileId,
              recipientProfileIds: retained.map((mention) => mention.profileId),
              excerpt: redactSensitiveText(text),
            });
          },
        }
      : {}),
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
