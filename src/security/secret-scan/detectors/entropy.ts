import RE2 from "re2";

import {
  BASE64_ENTROPY_THRESHOLD,
  BASE64_MIN_LENGTH,
  BASE64URL_MIN_LENGTH,
  HEX_ENTROPY_THRESHOLD,
  HEX_MIN_LENGTH,
} from "../constants.js";
import { hexEntropy, isHex, shannonEntropy } from "../entropy.js";
import { maskToken } from "../redact.js";
import type { SecretScanMatch } from "../types.js";
import type { DetectorKind, Redaction } from "./types.js";
import { execAll } from "./utils.js";

const BASE64_RE = new RE2(`[A-Za-z0-9+/=]{${BASE64_MIN_LENGTH},}`, "g");
const BASE64URL_RE = new RE2(`[A-Za-z0-9_-]{${BASE64URL_MIN_LENGTH},}`, "g");
const HEX_RE = new RE2(`[A-Fa-f0-9]{${HEX_MIN_LENGTH},}`, "g");

function hasValidBase64Padding(token: string): boolean {
  const paddingStart = token.indexOf("=");
  if (paddingStart === -1) return true;
  if (!/={1,2}$/.test(token)) return false;
  if (token.length % 4 !== 0) return false;
  return paddingStart >= token.length - 2;
}

export function addEntropyDetections(
  text: string,
  matches: SecretScanMatch[],
  redactions: Redaction[],
  seen: Set<string>,
): void {
  const addEntropyMatch = (
    token: string,
    start: number,
    kind: DetectorKind,
    confidence: SecretScanMatch["confidence"],
  ) => {
    const end = start + token.length;
    const key = `entropy:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ detector: "entropy", kind, confidence, start, end });
    redactions.push({ start, end, replacement: maskToken(token), detector: "entropy" });
  };

  execAll(HEX_RE, text, (match) => {
    const token = match[0];
    if (!token) return;
    const entropy = hexEntropy(token);
    if (entropy < HEX_ENTROPY_THRESHOLD) return;
    const start = match.index ?? 0;
    addEntropyMatch(token, start, "entropy", "low");
  });

  execAll(BASE64_RE, text, (match) => {
    const token = match[0];
    if (!token || isHex(token)) return;
    if (!hasValidBase64Padding(token)) return;
    const entropy = shannonEntropy(token);
    if (entropy < BASE64_ENTROPY_THRESHOLD) return;
    const start = match.index ?? 0;
    addEntropyMatch(token, start, "entropy", "low");
  });

  execAll(BASE64URL_RE, text, (match) => {
    const token = match[0];
    if (!token || isHex(token)) return;
    const entropy = shannonEntropy(token);
    if (entropy < BASE64_ENTROPY_THRESHOLD) return;
    const start = match.index ?? 0;
    addEntropyMatch(token, start, "entropy", "low");
  });
}
