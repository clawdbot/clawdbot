import type { OpenClawConfig } from "../config/types.openclaw.js";

type TranscriptReplayRoute = {
  api?: string;
  model?: string;
  provider?: string;
};

type TranscriptReplaySanitizerHelpers = {
  isAnthropicReasoningRoute: (route: TranscriptReplayRoute | undefined) => boolean;
  isOpenAIReplayContextHash: (value: unknown) => value is string;
  isOpenAIResponseItemId: (value: string, route: TranscriptReplayRoute | undefined) => boolean;
  isOpenAIResponsesApi: (api: string) => boolean;
  isOpenAIResponsesRoute: (route: TranscriptReplayRoute | undefined) => boolean;
  isPlainTranscriptObject: (value: object) => value is Record<string, unknown>;
  isStructurallyValidOpaqueReplayToken: (value: string) => boolean;
  redactTranscriptText: (value: string, cfg?: OpenClawConfig) => string;
};

const OPENAI_COMPACTION_REPLAY_TYPE = "openai-responses-compaction";
const OPENAI_COMPACTION_SUPPRESSION_TYPE = "openai-responses-compaction-suppression";
const OPENAI_COMPACTION_SUPPRESSION_DATA = "rejected";
const ANTHROPIC_COMPACTION_REPLAY_TYPE = "anthropic-compaction";
const ANTHROPIC_COMPACTION_SUPPRESSION_TYPE = "anthropic-compaction-suppression";
const ANTHROPIC_COMPACTION_SUPPRESSION_DATA = "rejected";

export function sanitizeOpenAICompactionReplayState(
  value: unknown,
  route: TranscriptReplayRoute | undefined,
  helpers: TranscriptReplaySanitizerHelpers,
): Record<string, unknown> | undefined {
  const replayType =
    value && typeof value === "object" && helpers.isPlainTranscriptObject(value)
      ? value.type
      : undefined;
  const isSuppression = replayType === OPENAI_COMPACTION_SUPPRESSION_TYPE;
  if (
    !value ||
    typeof value !== "object" ||
    !helpers.isPlainTranscriptObject(value) ||
    !helpers.isOpenAIResponsesRoute(route) ||
    value.v !== 1 ||
    (replayType !== OPENAI_COMPACTION_REPLAY_TYPE && !isSuppression) ||
    typeof value.data !== "string" ||
    (isSuppression
      ? value.data !== OPENAI_COMPACTION_SUPPRESSION_DATA
      : !helpers.isStructurallyValidOpaqueReplayToken(value.data)) ||
    (value.replayIndex !== undefined &&
      (isSuppression ||
        !Number.isSafeInteger(value.replayIndex) ||
        (value.replayIndex as number) < 0)) ||
    value.provider !== route?.provider ||
    typeof value.api !== "string" ||
    !helpers.isOpenAIResponsesApi(value.api) ||
    value.model !== route?.model ||
    !helpers.isOpenAIReplayContextHash(value.baseUrlHash) ||
    (value.sessionHash !== undefined && !helpers.isOpenAIReplayContextHash(value.sessionHash)) ||
    (value.authProfileHash !== undefined &&
      !helpers.isOpenAIReplayContextHash(value.authProfileHash))
  ) {
    return undefined;
  }
  const replayId =
    !isSuppression &&
    typeof value.id === "string" &&
    helpers.isOpenAIResponseItemId(value.id, route)
      ? value.id
      : undefined;
  return {
    v: 1,
    type: replayType,
    ...(replayId !== undefined ? { id: replayId } : {}),
    data: value.data,
    ...(value.replayIndex !== undefined ? { replayIndex: value.replayIndex } : {}),
    provider: value.provider,
    api: value.api,
    model: value.model,
    baseUrlHash: value.baseUrlHash,
    ...(value.sessionHash !== undefined ? { sessionHash: value.sessionHash } : {}),
    ...(value.authProfileHash !== undefined ? { authProfileHash: value.authProfileHash } : {}),
  };
}

export function sanitizeAnthropicCompactionReplayState(
  value: unknown,
  route: TranscriptReplayRoute | undefined,
  cfg: OpenClawConfig | undefined,
  helpers: TranscriptReplaySanitizerHelpers,
): Record<string, unknown> | undefined {
  const replayType =
    value && typeof value === "object" && helpers.isPlainTranscriptObject(value)
      ? value.type
      : undefined;
  const isSuppression = replayType === ANTHROPIC_COMPACTION_SUPPRESSION_TYPE;
  if (
    !value ||
    typeof value !== "object" ||
    !helpers.isPlainTranscriptObject(value) ||
    !helpers.isAnthropicReasoningRoute(route) ||
    value.v !== 1 ||
    (replayType !== ANTHROPIC_COMPACTION_REPLAY_TYPE && !isSuppression) ||
    typeof value.data !== "string" ||
    (isSuppression
      ? value.data !== ANTHROPIC_COMPACTION_SUPPRESSION_DATA
      : value.data.length === 0) ||
    (value.replayIndex !== undefined &&
      (isSuppression ||
        !Number.isSafeInteger(value.replayIndex) ||
        (value.replayIndex as number) < 0)) ||
    value.provider !== route?.provider ||
    value.api !== route?.api ||
    value.model !== route?.model ||
    !helpers.isOpenAIReplayContextHash(value.baseUrlHash) ||
    (value.sessionHash !== undefined && !helpers.isOpenAIReplayContextHash(value.sessionHash)) ||
    (value.authProfileHash !== undefined &&
      !helpers.isOpenAIReplayContextHash(value.authProfileHash))
  ) {
    return undefined;
  }
  return {
    v: 1,
    type: replayType,
    data: isSuppression ? value.data : helpers.redactTranscriptText(value.data, cfg),
    ...(value.replayIndex !== undefined ? { replayIndex: value.replayIndex } : {}),
    provider: value.provider,
    api: value.api,
    model: value.model,
    baseUrlHash: value.baseUrlHash,
    ...(value.sessionHash !== undefined ? { sessionHash: value.sessionHash } : {}),
    ...(value.authProfileHash !== undefined ? { authProfileHash: value.authProfileHash } : {}),
  };
}
