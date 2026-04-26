export function splitTrailingAuthProfile(raw: string): {
  model: string;
  profile?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { model: "" };
  }

  const lastSlash = trimmed.lastIndexOf("/");
  let profileDelimiter = trimmed.indexOf("@", lastSlash + 1);
  if (profileDelimiter <= 0) {
    return { model: trimmed };
  }

  const suffixAfterDelimiter = () => trimmed.slice(profileDelimiter + 1);

  // Keep well-known "version" suffixes (ex: @20251001) as part of the model id,
  // but allow an auth profile suffix *after* them (ex: ...@20251001@work).
  if (/^\d{8}(?:@|$)/.test(suffixAfterDelimiter())) {
    const nextDelimiter = trimmed.indexOf("@", profileDelimiter + 9);
    if (nextDelimiter < 0) {
      return { model: trimmed };
    }
    profileDelimiter = nextDelimiter;
  }

  // Keep local model quant suffixes (common in LM Studio/Ollama catalogs) as part
  // of the model id. These often use '@' (ex: gemma-4-31b-it@q8_0) which would
  // otherwise be misinterpreted as an auth profile delimiter.
  //
  // Covers standard GGUF quant tags (q4_0, q8_0, q4_k_xl, ...) and importance-
  // quantization variants (iq3_xxs, iq4_xs, ...) used by llama.cpp / LM Studio.
  //
  // If an auth profile is needed, it can still be specified as a second suffix:
  //   lmstudio/foo@q8_0@work   lmstudio/foo@iq3_xxs@work
  if (/^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i.test(suffixAfterDelimiter())) {
    const nextDelimiter = trimmed.indexOf("@", profileDelimiter + 1);
    if (nextDelimiter < 0) {
      return { model: trimmed };
    }
    profileDelimiter = nextDelimiter;
  }

  const model = trimmed.slice(0, profileDelimiter).trim();
  const profile = trimmed.slice(profileDelimiter + 1).trim();
  if (!model || !profile) {
    return { model: trimmed };
  }

  return { model, profile };
}
