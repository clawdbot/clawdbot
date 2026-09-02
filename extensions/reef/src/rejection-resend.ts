import { bodyHash as hashMessageBody } from "../protocol/index.js";

function normalizeReefMessageText(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

export function reefMessageTextHash(text: string): string {
  return hashMessageBody({ text: normalizeReefMessageText(text) });
}

export function isRephrasedReefResend(text: string, originalTextHash: string | undefined): boolean {
  const normalized = normalizeReefMessageText(text);
  return (
    normalized.length > 0 &&
    originalTextHash !== undefined &&
    reefMessageTextHash(normalized) !== originalTextHash
  );
}
