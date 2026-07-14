const CLAUDE_ACP_OPENCLAW_PREFIX = "anthropic/";
const CLAUDE_ACP_EFFORT_CONFIG_KEYS = new Set([
  "effort",
  "reasoning_effort",
  "thinking",
  "thought_level",
]);
const CLAUDE_ACP_DISABLED_EFFORT_VALUES = new Set(["none", "off"]);

export function isDisabledClaudeAcpEffortConfig(key: string, value: string): boolean {
  return (
    CLAUDE_ACP_EFFORT_CONFIG_KEYS.has(key) &&
    CLAUDE_ACP_DISABLED_EFFORT_VALUES.has(value.trim().toLowerCase())
  );
}

export function normalizeClaudeAcpModelOverride(rawModel: string | undefined): string | undefined {
  const raw = rawModel?.trim();
  if (!raw) {
    return undefined;
  }
  if (!raw.toLowerCase().startsWith(CLAUDE_ACP_OPENCLAW_PREFIX)) {
    return raw;
  }
  return raw.slice(CLAUDE_ACP_OPENCLAW_PREFIX.length).trim() || undefined;
}
