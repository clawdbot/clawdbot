import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
/**
 * Gateway-side token counting via js-tiktoken.
 *
 * Used for session context snapshots when providers omit contextUsage.
 * Unknown / custom models default to o200k_base and are marked approximate.
 */
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import o200k_base from "js-tiktoken/ranks/o200k_base";
import { estimateTokensFromChars, estimateStringChars } from "../utils/cjk-chars.js";

export type TokenEncodingName = "o200k_base" | "cl100k_base";

const ENCODERS = new Map<TokenEncodingName, Tiktoken>();

function getEncoder(encoding: TokenEncodingName): Tiktoken {
  const cached = ENCODERS.get(encoding);
  if (cached) {
    return cached;
  }
  const ranks = encoding === "cl100k_base" ? cl100k_base : o200k_base;
  const encoder = new Tiktoken(ranks);
  ENCODERS.set(encoding, encoder);
  return encoder;
}

/** Resolve tiktoken encoding for a provider/model pair. */
export function resolveTokenEncoding(params: {
  provider?: string | null;
  model?: string | null;
  encodingOverride?: string | null;
}): { encoding: TokenEncodingName; approximate: boolean } {
  const override = normalizeLowercaseStringOrEmpty(params.encodingOverride);
  if (override === "cl100k_base" || override === "cl100k") {
    return { encoding: "cl100k_base", approximate: false };
  }
  if (override === "o200k_base" || override === "o200k") {
    return { encoding: "o200k_base", approximate: false };
  }

  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const model = normalizeLowercaseStringOrEmpty(params.model);

  if (
    provider === "openai" ||
    provider === "openai-codex" ||
    model.includes("gpt-4o") ||
    model.includes("gpt-4.1") ||
    model.includes("gpt-5") ||
    model.includes("o1") ||
    model.includes("o3") ||
    model.includes("o4")
  ) {
    return { encoding: "o200k_base", approximate: false };
  }

  if (provider === "openai" || model.includes("gpt-4") || model.includes("gpt-3.5")) {
    return { encoding: "cl100k_base", approximate: false };
  }

  // Custom / Qwen / unknown: still tokenize with o200k for a real BPE count,
  // but flag approximate — vocab may differ from the serving model.
  return { encoding: "o200k_base", approximate: true };
}

/** Count tokens for a UTF-8 text string. Falls back to CJK-aware chars/4 on failure. */
export function countTextTokens(
  text: string,
  params: { encoding?: TokenEncodingName } = {},
): { tokens: number; approximate: boolean } {
  if (!text) {
    return { tokens: 0, approximate: false };
  }
  const encoding = params.encoding ?? "o200k_base";
  try {
    const tokens = getEncoder(encoding).encode(text).length;
    return { tokens, approximate: false };
  } catch {
    return {
      tokens: estimateTokensFromChars(estimateStringChars(text)),
      approximate: true,
    };
  }
}

/** Count tokens for a known character length when the source text is unavailable. */
export function countTokensFromChars(
  chars: number,
  params: { encoding?: TokenEncodingName } = {},
): { tokens: number; approximate: true } {
  void params;
  return {
    tokens: estimateTokensFromChars(Math.max(0, Math.floor(chars))),
    approximate: true,
  };
}
