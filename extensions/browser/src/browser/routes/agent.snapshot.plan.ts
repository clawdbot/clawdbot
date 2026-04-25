import type { ResolvedBrowserProfile } from "../config.js";
import {
  DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH,
  DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
} from "../constants.js";
import {
  resolveDefaultSnapshotFormat,
  shouldUsePlaywrightForAriaSnapshot,
  shouldUsePlaywrightForScreenshot,
} from "../profile-capabilities.js";
import { toBoolean, toNumber, toStringOrEmpty } from "./utils.js";

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return readStringValue(value)?.trim() || undefined;
}

export type BrowserSnapshotPlan = {
  format: "ai" | "aria";
  mode?: "efficient";
  labels?: boolean;
  urls?: boolean;
  limit?: number;
  resolvedMaxChars?: number;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  refsMode?: "aria" | "role";
  selectorValue?: string;
  frameSelectorValue?: string;
  wantsRoleSnapshot: boolean;
};

export function resolveSnapshotPlan(params: {
  profile: ResolvedBrowserProfile;
  query: Record<string, unknown>;
  hasPlaywright: boolean;
}): BrowserSnapshotPlan {
  const mode = params.query.mode === "efficient" ? "efficient" : undefined;
  const labels = toBoolean(params.query.labels) ?? undefined;
  const urls = toBoolean(params.query.urls) ?? undefined;
  const explicitFormat =
    params.query.format === "aria" ? "aria" : params.query.format === "ai" ? "ai" : undefined;
  const format = resolveDefaultSnapshotFormat({
    profile: params.profile,
    hasPlaywright: params.hasPlaywright,
    explicitFormat,
    mode,
  });
  const limitRaw = readStringValue(params.query.limit);
  const hasMaxChars = Object.hasOwn(params.query, "maxChars");
  const maxCharsRaw = readStringValue(params.query.maxChars);
  const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
  const maxChars =
    Number.isFinite(Number(maxCharsRaw)) && Number(maxCharsRaw) > 0
      ? Math.floor(Number(maxCharsRaw))
      : undefined;
  const resolvedMaxChars =
    format === "ai"
      ? hasMaxChars
        ? maxChars
        : mode === "efficient"
          ? DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS
          : DEFAULT_AI_SNAPSHOT_MAX_CHARS
      : undefined;
  const interactiveRaw = toBoolean(params.query.interactive);
  const compactRaw = toBoolean(params.query.compact);
  const depthRaw = toNumber(params.query.depth);
  const refsModeRaw = toStringOrEmpty(params.query.refs).trim();
  const refsMode: "aria" | "role" | undefined =
    refsModeRaw === "aria" ? "aria" : refsModeRaw === "role" ? "role" : undefined;
  const interactive = interactiveRaw ?? (mode === "efficient" ? true : undefined);
  const compact = compactRaw ?? (mode === "efficient" ? true : undefined);
  const depth =
    depthRaw ?? (mode === "efficient" ? DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH : undefined);
  const selectorValue = normalizeOptionalString(toStringOrEmpty(params.query.selector));
  const frameSelectorValue = normalizeOptionalString(toStringOrEmpty(params.query.frame));

  return {
    format,
    mode,
    labels,
    urls,
    limit,
    resolvedMaxChars,
    interactive,
    compact,
    depth,
    refsMode,
    selectorValue,
    frameSelectorValue,
    wantsRoleSnapshot:
      labels === true ||
      urls === true ||
      mode === "efficient" ||
      interactive === true ||
      compact === true ||
      depth !== undefined ||
      Boolean(selectorValue) ||
      Boolean(frameSelectorValue),
  };
}

export { shouldUsePlaywrightForAriaSnapshot, shouldUsePlaywrightForScreenshot };
