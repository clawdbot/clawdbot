import { readOpenAIResponsesCompactionWindow } from "@openclaw/ai/internal/openai-responses-payload-policy";
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
  redactTranscriptStructuredValue: (value: unknown, cfg?: OpenClawConfig) => unknown;
  redactTranscriptText: (value: string, cfg?: OpenClawConfig) => string;
};

type TranscriptReplayDescriptor = {
  replayTypes: readonly string[];
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
  replayTypes: ["openai-responses-compaction", "openai-responses-retained-compaction"],
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
  replayTypes: ["anthropic-compaction"],
  suppressionType: "anthropic-compaction-suppression",
  matchesRoute: (route, helpers) => helpers.isAnthropicReasoningRoute(route),
  matchesApi: (api, route) => api === route?.api,
  sanitizeData: (data, cfg, helpers) =>
    data.length > 0 ? helpers.redactTranscriptText(data, cfg) : undefined,
};

const REPLAY_DESCRIPTORS = [OPENAI_REPLAY_DESCRIPTOR, ANTHROPIC_REPLAY_DESCRIPTOR];

function sanitizeCompactedWindow(
  replay: { data: string; id?: string; compactedWindow?: unknown },
  cfg: OpenClawConfig | undefined,
  helpers: TranscriptReplaySanitizerHelpers,
) {
  const window = replay.compactedWindow;
  const output = readOpenAIResponsesCompactionWindow(replay);
  const unchanged = output?.every((item) => {
    if (item.type !== "compaction") {
      return helpers.redactTranscriptStructuredValue(item, cfg) === item;
    }
    // Only the encrypted token is opaque; optional provider fields still pass
    // through the same plaintext policy as the retained messages.
    const { encrypted_content: _encrypted, ...plaintext } = item;
    return helpers.redactTranscriptStructuredValue(plaintext, cfg) === plaintext;
  });
  return unchanged &&
    window &&
    typeof window === "object" &&
    helpers.isPlainTranscriptObject(window) &&
    typeof window.output === "string"
    ? { state: "ready", output: window.output }
    : { state: "refresh-required" };
}

export function sanitizeCompactionReplayState(
  value: unknown,
  route: TranscriptReplayRoute | undefined,
  cfg: OpenClawConfig | undefined,
  helpers: TranscriptReplaySanitizerHelpers,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || !helpers.isPlainTranscriptObject(value)) {
    return undefined;
  }
  const replayType = typeof value.type === "string" ? value.type : "";
  const descriptor = REPLAY_DESCRIPTORS.find(
    ({ replayTypes, suppressionType }) =>
      replayTypes.includes(replayType) || replayType === suppressionType,
  );
  const isSuppression = value.type === descriptor?.suppressionType;
  if (
    !descriptor ||
    !descriptor.matchesRoute(route, helpers) ||
    value.v !== 1 ||
    typeof value.data !== "string" ||
    (value.type === "openai-responses-retained-compaction" && value.replayIndex !== undefined) ||
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
    ...(!isSuppression &&
    descriptor === OPENAI_REPLAY_DESCRIPTOR &&
    value.compactedWindow !== undefined
      ? {
          // Keep the newest fenced barrier when its canonical plaintext cannot
          // survive redaction; dropping it could expose an older checkpoint.
          compactedWindow: sanitizeCompactedWindow(
            { data, id: replayId, compactedWindow: value.compactedWindow },
            cfg,
            helpers,
          ),
        }
      : {}),
  };
}
