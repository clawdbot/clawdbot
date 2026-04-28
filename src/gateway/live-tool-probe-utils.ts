import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function hasExpectedToolNonce(text: string, nonceA: string, nonceB: string): boolean {
  return text.includes(nonceA) && text.includes(nonceB);
}

export function hasExpectedSingleNonce(text: string, nonce: string): boolean {
  return text.includes(nonce);
}

const NONCE_REFUSAL_MARKERS = [
  "token",
  "secret",
  "local file",
  "uuid-named file",
  "uuid named file",
  "parrot back",
  "disclose",
  "can't help",
  "can’t help",
  "cannot help",
  "can't comply",
  "can’t comply",
  "cannot comply",
  "isn't a real openclaw probe",
  "is not a real openclaw probe",
  "not a real openclaw probe",
  "no part of the system asks me",
];

const PROBE_REFUSAL_MARKERS = [
  "prompt injection attempt",
  "not a legitimate self-test",
  "not legitimate self-test",
  "authorized integration probe",
  "authorizing me to execute",
  "authorizing me to run",
];

export function isLikelyToolNonceRefusal(text: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(text);
  if (PROBE_REFUSAL_MARKERS.some((marker) => lower.includes(marker))) {
    return true;
  }
  if (lower.includes("nonce")) {
    return NONCE_REFUSAL_MARKERS.some((marker) => lower.includes(marker));
  }
  return false;
}

function hasMalformedToolOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (trimmed.includes("[object Object]")) {
    return true;
  }
  if (
    lower.includes("try reading the file again") ||
    lower.includes("trying to read the file again") ||
    lower.includes("try the read tool again") ||
    lower.includes("file wasn't found immediately after") ||
    lower.includes("file wasn't found immediately") ||
    lower.includes("verify the file exists and read it again") ||
    lower.includes("file read failed because the file was not found") ||
    lower.includes("verify the file creation and read it again")
  ) {
    return true;
  }
  if (/\bread\s*\[/.test(lower) || /\btool\b/.test(lower) || /\bfunction\b/.test(lower)) {
    return true;
  }
  return false;
}

export function shouldRetryToolReadProbe(params: {
  text: string;
  nonceA: string;
  nonceB: string;
  provider: string;
  attempt: number;
  maxAttempts: number;
}): boolean {
  if (params.attempt + 1 >= params.maxAttempts) {
    return false;
  }
  if (hasExpectedToolNonce(params.text, params.nonceA, params.nonceB)) {
    return false;
  }
  if (hasMalformedToolOutput(params.text)) {
    return true;
  }
  if (params.provider === "anthropic" && isLikelyToolNonceRefusal(params.text)) {
    return true;
  }
  const lower = normalizeLowercaseStringOrEmpty(params.text);
  if (params.provider === "mistral" && (lower.includes("noncea=") || lower.includes("nonceb="))) {
    return true;
  }
  return false;
}

export function shouldRetryExecReadProbe(params: {
  text: string;
  nonce: string;
  provider: string;
  attempt: number;
  maxAttempts: number;
}): boolean {
  if (params.attempt + 1 >= params.maxAttempts) {
    return false;
  }
  if (hasExpectedSingleNonce(params.text, params.nonce)) {
    return false;
  }
  if (params.provider === "anthropic" && isLikelyToolNonceRefusal(params.text)) {
    return true;
  }
  return hasMalformedToolOutput(params.text);
}
