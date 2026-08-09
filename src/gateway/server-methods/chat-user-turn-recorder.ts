import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  buildRestartSafeChatTranscriptState,
  type RestartSafeChatAdmission,
} from "./chat-restart-recovery.js";

type DiagnosticsAttributes = Record<string, string | number | boolean | null>;

type GatewayChatUserTurnController = {
  baseInput: UserTurnInput;
  persist: ReturnType<typeof createUserTurnTranscriptRecorder>["persistFallback"];
  persistBestEffort: () => Promise<void>;
  recorder: UserTurnTranscriptRecorder;
  setAcceptedSessionId: (sessionId: string) => void;
  setInputPromise: (input: Promise<UserTurnInput>) => void;
};

export function createGatewayChatUserTurnController(params: {
  agentId: string;
  cfg: OpenClawConfig;
  clientRunId: string;
  initialSessionId: string;
  now: number;
  provenance?: InputProvenance;
  rawMessage: string;
  restartAdmission?: RestartSafeChatAdmission;
  sender?: UserTurnInput["sender"];
  senderIsOwner: boolean;
  sessionKey: string;
  sessionLoadOptions?: { agentId?: string; clone?: boolean };
  startedAt: number;
  traceAttributes: DiagnosticsAttributes;
  warn: (message: string) => void;
}): GatewayChatUserTurnController {
  const baseInput: UserTurnInput = {
    text: params.rawMessage,
    timestamp: params.now,
    idempotencyKey: buildRunUserTurnIdempotencyKey(params.clientRunId),
    ...(params.sender ? { sender: params.sender } : {}),
    ...(params.senderIsOwner ? { senderIsOwner: true } : {}),
    ...(params.provenance ? { provenance: params.provenance } : {}),
  };
  let inputPromise = Promise.resolve(baseInput);
  let acceptedSessionId = params.initialSessionId;
  const recorder = createUserTurnTranscriptRecorder({
    input: baseInput,
    resolveInput: () => inputPromise,
    target: () => {
      const { storePath, store, entry } = loadSessionEntry(
        params.sessionKey,
        params.sessionLoadOptions,
      );
      if (!entry?.sessionId || entry.sessionId !== acceptedSessionId) {
        return undefined;
      }
      return {
        sessionId: entry.sessionId,
        expectedSessionId: entry.sessionId,
        sessionKey: params.sessionKey,
        sessionEntry: entry,
        sessionStore: store,
        storePath,
        agentId: params.agentId,
        config: params.cfg,
      };
    },
    ...(params.restartAdmission
      ? buildRestartSafeChatTranscriptState({
          admission: params.restartAdmission,
          clientRunId: params.clientRunId,
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
        config: params.cfg,
        attributes: params.traceAttributes,
      },
    );
  return {
    baseInput,
    persist,
    persistBestEffort: async () => {
      await persist().catch(() => undefined);
    },
    recorder,
    setAcceptedSessionId: (sessionId) => {
      acceptedSessionId = sessionId;
    },
    setInputPromise: (input) => {
      inputPromise = input;
    },
  };
}
