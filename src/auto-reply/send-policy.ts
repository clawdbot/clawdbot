import { normalizeCommandBody } from "./commands-registry.js";

export type SendPolicyOverride = "allow" | "deny";

export function normalizeSendPolicyOverride(
  raw?: string | null,
): SendPolicyOverride | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "allow" || value === "on") return "allow";
  if (value === "deny" || value === "off") return "deny";
  return undefined;
}

export function parseSendPolicyCommand(raw?: string): {
  hasCommand: boolean;
  mode?: SendPolicyOverride | "inherit";
} {
  if (!raw) return { hasCommand: false };
  const trimmed = raw.trim();
  if (!trimmed) return { hasCommand: false };
  const normalized = normalizeCommandBody(trimmed);
  const match = normalized.match(/^\/send(?:\s+([a-zA-Z]+))?\s*$/i);
  if (!match) return { hasCommand: false };
  const token = match[1]?.trim().toLowerCase();
  if (!token) return { hasCommand: true };
  if (token === "inherit" || token === "default" || token === "reset") {
    return { hasCommand: true, mode: "inherit" };
  }
  const mode = normalizeSendPolicyOverride(token);
  return { hasCommand: true, mode };
}
