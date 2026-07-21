// Pure platform and payload helpers for remote skill binary probes.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { SkillEntry } from "../types.js";

export function extractErrorMessage(err: unknown): string | undefined {
  if (!err) {
    return undefined;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    return err.toString();
  }
  if (typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isMacPlatform(platform?: string, deviceFamily?: string): boolean {
  const platformNorm = normalizeLowercaseStringOrEmpty(platform);
  const familyNorm = normalizeLowercaseStringOrEmpty(deviceFamily);
  return platformNorm.includes("mac") || platformNorm.includes("darwin") || familyNorm === "mac";
}

export function supportsSystemRun(commands?: string[]): boolean {
  return Array.isArray(commands) && commands.includes("system.run");
}

export function supportsSystemWhich(commands?: string[]): boolean {
  return Array.isArray(commands) && commands.includes("system.which");
}

export function collectRequiredBins(entries: SkillEntry[], targetPlatform: string): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const os = entry.metadata?.os ?? [];
    if (os.length > 0 && !os.includes(targetPlatform)) {
      continue;
    }
    for (const bin of [
      ...(entry.metadata?.requires?.bins ?? []),
      ...(entry.metadata?.requires?.anyBins ?? []),
    ]) {
      if (bin.trim()) {
        bins.add(bin.trim());
      }
    }
  }
  return [...bins];
}

export function buildBinProbeScript(bins: string[]): string {
  const escaped = bins.map((bin) => `'${bin.replace(/'/g, `'\\''`)}'`).join(" ");
  return `for b in ${escaped}; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; fi; done`;
}

export function parseBinProbePayload(
  payloadJSON: string | null | undefined,
  payload?: unknown,
): string[] {
  if (!payloadJSON && !payload) {
    return [];
  }
  try {
    const parsed = payloadJSON
      ? (JSON.parse(payloadJSON) as { stdout?: unknown; bins?: unknown })
      : (payload as { stdout?: unknown; bins?: unknown });
    if (Array.isArray(parsed.bins)) {
      return normalizeStringEntries(parsed.bins);
    }
    if (parsed.bins && typeof parsed.bins === "object") {
      return Object.entries(parsed.bins)
        .filter(([, resolvedPath]) => normalizeOptionalString(resolvedPath) !== undefined)
        .map(([bin]) => normalizeOptionalString(bin) ?? "")
        .filter(Boolean);
    }
    if (typeof parsed.stdout === "string") {
      return parsed.stdout
        .split(/\r?\n/)
        .map((line) => normalizeOptionalString(line) ?? "")
        .filter(Boolean);
    }
  } catch {
    return [];
  }
  return [];
}

export function areBinSetsEqual(a: Set<string> | undefined, b: Set<string>): boolean {
  if (!a || a.size !== b.size) {
    return false;
  }
  for (const bin of b) {
    if (!a.has(bin)) {
      return false;
    }
  }
  return true;
}
