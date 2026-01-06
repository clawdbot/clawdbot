export type GroupActivationMode = "mention" | "always";

export function normalizeGroupActivation(
  raw?: string | null,
): GroupActivationMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "mention") return "mention";
  if (value === "always") return "always";
  return undefined;
}

export function parseActivationCommand(raw?: string): {
  hasCommand: boolean;
  mode?: GroupActivationMode;
} {
  if (!raw) return { hasCommand: false };
  const trimmed = raw.trim();
  if (!trimmed) return { hasCommand: false };
  const match = trimmed.match(/^\/activation\b(?:\s+([a-zA-Z]+))?/i);
  if (!match) return { hasCommand: false };
  const mode = normalizeGroupActivation(match[1]);
  return { hasCommand: true, mode };
}
