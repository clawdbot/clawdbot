// Group activation command parser for mention/always auto-reply modes.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

/** Supported group activation modes. */
export type GroupActivationMode = "mention" | "always";

/** Normalize a raw group activation mode string. */
export function normalizeGroupActivation(raw?: string | null): GroupActivationMode | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (value === "mention") {
    return "mention";
  }
  if (value === "always") {
    return "always";
  }
  return undefined;
}

/** Parse `/activation` commands from inbound message text. */
export function parseActivationCommand(raw?: string): {
  hasCommand: boolean;
  mode?: GroupActivationMode;
} {
  if (!raw) {
    return { hasCommand: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { hasCommand: false };
  }
  const normalized = trimmed.replace(/^\/([^\s:]+)\s*:(.*)$/, (_, cmd: string, rest: string) => {
    const trimmedRest = rest.trimStart();
    return trimmedRest ? `/${cmd} ${trimmedRest}` : `/${cmd}`;
  });
  const match = normalized.match(/^\/activation(?:\s+([a-zA-Z]+))?\s*$/i);
  if (!match) {
    return { hasCommand: false };
  }
  const mode = normalizeGroupActivation(match[1]);
  return { hasCommand: true, mode };
}
