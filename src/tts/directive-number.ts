// TTS directive number helpers parse strict numeric directive values.
import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderOverrides,
} from "./provider-types.js";

/** Numeric directive parsing shared by speech providers with bounded knobs. */
type DirectiveNumberRange = {
  min?: number;
  max?: number;
  minExclusive?: boolean;
  maxExclusive?: boolean;
};

function isInDirectiveNumberRange(value: number, range: DirectiveNumberRange): boolean {
  if (range.min !== undefined && (range.minExclusive ? value <= range.min : value < range.min)) {
    return false;
  }
  if (range.max !== undefined && (range.maxExclusive ? value >= range.max : value > range.max)) {
    return false;
  }
  return true;
}

/** Parse a numeric speech directive token and return provider overrides when policy allows it. */
export function parseSpeechDirectiveNumberOverride(params: {
  ctx: SpeechDirectiveTokenParseContext;
  overrideKey: string;
  range: DirectiveNumberRange;
  warning: (value: string) => string;
  mergeCurrentOverrides?: boolean;
}): SpeechDirectiveTokenParseResult {
  if (!params.ctx.policy.allowVoiceSettings) {
    return { handled: true };
  }

  const value = parseStrictFiniteNumber(params.ctx.value);
  if (value === undefined || !isInDirectiveNumberRange(value, params.range)) {
    return { handled: true, warnings: [params.warning(params.ctx.value)] };
  }

  const nextOverride: SpeechProviderOverrides = { [params.overrideKey]: value };
  return {
    handled: true,
    overrides: params.mergeCurrentOverrides
      ? { ...params.ctx.currentOverrides, ...nextOverride }
      : nextOverride,
  };
}
