import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";

export function parseSandboxStatSize(value: string | undefined): number {
  const raw = value ?? "0";
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed !== undefined) {
    return parsed;
  }
  return /^\d+$/.test(raw) ? Number.MAX_SAFE_INTEGER : 0;
}

export function parseSandboxStatMtimeMs(value: string | undefined): number {
  const raw = value ?? "0";
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const mtimeMs = Number(raw) * 1000;
    return Number.isFinite(mtimeMs) ? mtimeMs : 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
