import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const DTMF_PATTERN = /^[0-9*#wWpP,]+$/;

export function normalizeDialInNumber(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const compact = normalized.replace(/[()\s.-]/g, "");
  if (!/^\+?[0-9]{5,20}$/.test(compact)) {
    throw new Error("dialInNumber must be a phone number");
  }
  return compact;
}

function normalizeDtmfSequence(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const compact = normalized.replace(/\s+/g, "");
  if (!DTMF_PATTERN.test(compact)) {
    throw new Error("dtmfSequence may only contain digits, *, #, comma, w, p");
  }
  return compact;
}

export function buildMeetDtmfSequence(params: {
  pin?: string;
  dtmfSequence?: string;
}): string | undefined {
  const explicit = normalizeDtmfSequence(params.dtmfSequence);
  if (explicit) {
    return explicit;
  }
  const pin = normalizeOptionalString(params.pin);
  if (!pin) {
    return undefined;
  }
  const compactPin = pin.replace(/\s+/g, "");
  if (!/^[0-9]+#?$/.test(compactPin)) {
    throw new Error("pin may only contain digits and an optional trailing #");
  }
  return compactPin.endsWith("#") ? compactPin : `${compactPin}#`;
}

export function prefixDtmfWait(sequence: string | undefined, delayMs: number): string | undefined {
  if (!sequence || delayMs <= 0) {
    return sequence;
  }
  const waitCount = Math.ceil(delayMs / 500);
  if (waitCount <= 0) {
    return sequence;
  }
  return `${"w".repeat(waitCount)}${sequence}`;
}
