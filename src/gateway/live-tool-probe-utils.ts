// Gateway live tool probe utilities.
// Classifies nonce probe replies and retry conditions for live provider checks.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Returns true when both expected tool-read nonces are present. */
export function hasExpectedToolNonce(text: string, nonceA: string, nonceB: string): boolean {
  return text.includes(nonceA) && text.includes(nonceB);
}

/** Returns true when the expected exec-read nonce is present. */
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
  "no `read`",
  "no read tool",
  "no `read`/`read` tool",
  "no read/read tool",
  "no read tool available",
  "won't output",
  "won’t output",
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

/** Detects likely safety refusals for authorized nonce probes. */
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
    lower.includes("try again with a slightly different approach") ||
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

/** Returns true when a file-read tool probe should retry before failing. */
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

/** Returns true when an exec-read probe should retry before failing. */
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
