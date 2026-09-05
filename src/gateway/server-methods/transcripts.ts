import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  validateTranscriptsGetParams,
  validateTranscriptsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import {
  isTranscriptSessionActive,
  resolveSourceProvider,
} from "../../agents/tools/transcripts-tool-runtime.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTranscriptsConfig } from "../../transcripts/config.js";
import { projectTranscriptSession, readTranscriptNotes } from "../../transcripts/read.js";
import type { TranscriptReadEntry } from "../../transcripts/store-read.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function createStore() {
  const stateDir = resolveStateDir();
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function projectSessions(entries: TranscriptReadEntry[], config: OpenClawConfig) {
  const names = new Map<string, string | undefined>();
  return entries.map((entry) => {
    const providerId = entry.session.source.providerId;
    if (!names.has(providerId)) {
      names.set(
        providerId,
        resolveSourceProvider(providerId, { config, stateDir: resolveStateDir(), logger: console })
          ?.name,
      );
    }
    return projectTranscriptSession(
      entry,
      isTranscriptSessionActive(entry.session),
      names.get(providerId),
    );
  });
}

export const transcriptsHandlers: GatewayRequestHandlers = {
  "transcripts.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTranscriptsListParams, "transcripts.list", respond)) {
      return;
    }
    const entries = createStore().listReadEntries({
      limit: params.limit ?? 50,
      providerId: params.providerId,
    });
    respond(true, { sessions: projectSessions(entries, context.getRuntimeConfig()) });
  },
  "transcripts.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTranscriptsGetParams, "transcripts.get", respond)) {
      return;
    }
    const store = createStore();
    const session = await store.readSession(params.selector);
    if (!session) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "transcripts session not found", {
          details: { type: "transcript_session_not_found", selector: params.selector },
        }),
      );
      return;
    }
    const config = context.getRuntimeConfig();
    const entries = store.listReadEntries({ limit: 1, session });
    const summary = await readTranscriptNotes(store, session);
    const utterances = params.includeUtterances
      ? store
          .readUtteranceEntries(session, resolveTranscriptsConfig(config.transcripts).maxUtterances)
          .map((row) => ({
            sequence: row.sequence,
            startedAt: row.started_at ?? undefined,
            endedAt: row.ended_at ?? undefined,
            speakerId: row.speaker_id ?? undefined,
            speakerLabel:
              row.speaker_label === null ? undefined : sanitizeTerminalText(row.speaker_label),
            text: truncateUtf16Safe(sanitizeTerminalText(row.text), 4000),
            final: row.final === null ? undefined : row.final === 1,
          }))
      : undefined;
    respond(true, { session: projectSessions(entries, config)[0], summary, utterances });
  },
};
