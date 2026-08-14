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

type TranscriptReplayDescriptor = {
  replayType: string;
  suppressionType: string;
  matchesRoute: (
    route: TranscriptReplayRoute | undefined,
    helpers: TranscriptReplaySanitizerHelpers,
  ) => boolean;
  matchesApi: (
    api: unknown,
    route: TranscriptReplayRoute | undefined,
    helpers: TranscriptReplaySanitizerHelpers,
  ) => boolean;
  sanitizeData: (
    data: string,
    cfg: OpenClawConfig | undefined,
    helpers: TranscriptReplaySanitizerHelpers,
  ) => string | undefined;
  readId?: (
    value: Record<string, unknown>,
    route: TranscriptReplayRoute | undefined,
    helpers: TranscriptReplaySanitizerHelpers,
  ) => string | undefined;
};

const OPENAI_REPLAY_DESCRIPTOR: TranscriptReplayDescriptor = {
  replayType: "openai-responses-compaction",
  suppressionType: "openai-responses-compaction-suppression",
  matchesRoute: (route, helpers) => helpers.isOpenAIResponsesRoute(route),
  matchesApi: (api, _route, helpers) =>
    typeof api === "string" && helpers.isOpenAIResponsesApi(api),
  sanitizeData: (data, _cfg, helpers) =>
    helpers.isStructurallyValidOpaqueReplayToken(data) ? data : undefined,
  readId: (value, route, helpers) =>
    typeof value.id === "string" && helpers.isOpenAIResponseItemId(value.id, route)
      ? value.id
      : undefined,
};

const ANTHROPIC_REPLAY_DESCRIPTOR: TranscriptReplayDescriptor = {
  replayType: "anthropic-compaction",
  suppressionType: "anthropic-compaction-suppression",
  matchesRoute: (route, helpers) => helpers.isAnthropicReasoningRoute(route),
  matchesApi: (api, route) => api === route?.api,
  sanitizeData: (data, cfg, helpers) =>
    data.length > 0 ? helpers.redactTranscriptText(data, cfg) : undefined,
};

const REPLAY_DESCRIPTORS = [OPENAI_REPLAY_DESCRIPTOR, ANTHROPIC_REPLAY_DESCRIPTOR];

export function sanitizeCompactionReplayState(
  value: unknown,
  route: TranscriptReplayRoute | undefined,
  cfg: OpenClawConfig | undefined,
  helpers: TranscriptReplaySanitizerHelpers,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || !helpers.isPlainTranscriptObject(value)) {
    return undefined;
  }
  const descriptor = REPLAY_DESCRIPTORS.find(
    ({ replayType, suppressionType }) =>
      value.type === replayType || value.type === suppressionType,
  );
  const isSuppression = value.type === descriptor?.suppressionType;
  if (
    !descriptor ||
    !descriptor.matchesRoute(route, helpers) ||
    value.v !== 1 ||
    typeof value.data !== "string" ||
    (value.replayIndex !== undefined &&
      (isSuppression ||
        !Number.isSafeInteger(value.replayIndex) ||
        (value.replayIndex as number) < 0)) ||
    value.provider !== route?.provider ||
    !descriptor.matchesApi(value.api, route, helpers) ||
    value.model !== route?.model ||
    !helpers.isOpenAIReplayContextHash(value.baseUrlHash) ||
    (value.sessionHash !== undefined && !helpers.isOpenAIReplayContextHash(value.sessionHash)) ||
    (value.authProfileHash !== undefined &&
      !helpers.isOpenAIReplayContextHash(value.authProfileHash))
  ) {
    return undefined;
  }
  const data = isSuppression
    ? value.data === "rejected"
      ? value.data
      : undefined
    : descriptor.sanitizeData(value.data, cfg, helpers);
  if (data === undefined) {
    return undefined;
  }
  const replayId = isSuppression ? undefined : descriptor.readId?.(value, route, helpers);
  return {
    v: 1,
    type: value.type,
    ...(replayId !== undefined ? { id: replayId } : {}),
    data,
    ...(value.replayIndex !== undefined ? { replayIndex: value.replayIndex } : {}),
    provider: value.provider,
    api: value.api,
    model: value.model,
    baseUrlHash: value.baseUrlHash,
    ...(value.sessionHash !== undefined ? { sessionHash: value.sessionHash } : {}),
    ...(value.authProfileHash !== undefined ? { authProfileHash: value.authProfileHash } : {}),
  };
}
