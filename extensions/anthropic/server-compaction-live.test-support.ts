export const ANTHROPIC_COMPACTION_LIVE_ENV = "OPENCLAW_LIVE_ANTHROPIC_COMPACTION";

type AnthropicCompactionLiveSettings =
  | { enabled: false }
  | {
      enabled: true;
      apiKey: string;
      modelId: string;
      compactThreshold: number;
      denseTurnChars: number;
      maxDenseTurns: number;
      requestTimeoutMs: number;
      suiteTimeoutMs: number;
    };

function readStrictFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "" || raw === "0") {
    return false;
  }
  if (raw === "1") {
    return true;
  }
  throw new Error(`${name} must be exactly 0 or 1`);
}

export function resolveAnthropicCompactionLiveSettings(
  env: Record<string, string | undefined>,
  liveEnabled: boolean,
): AnthropicCompactionLiveSettings {
  if (!readStrictFlag(ANTHROPIC_COMPACTION_LIVE_ENV, env[ANTHROPIC_COMPACTION_LIVE_ENV])) {
    return { enabled: false };
  }
  if (!liveEnabled) {
    throw new Error(`${ANTHROPIC_COMPACTION_LIVE_ENV}=1 also requires OPENCLAW_LIVE_TEST=1`);
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(`${ANTHROPIC_COMPACTION_LIVE_ENV}=1 requires ANTHROPIC_API_KEY`);
  }
  return {
    enabled: true,
    apiKey,
    modelId: env.OPENCLAW_LIVE_ANTHROPIC_COMPACTION_MODEL?.trim() || "claude-sonnet-4-6",
    compactThreshold: 50_000,
    denseTurnChars: 180_000,
    maxDenseTurns: 3,
    requestTimeoutMs: 5 * 60_000,
    suiteTimeoutMs: 15 * 60_000,
  };
}

export function buildAnthropicCompactionContextChunk(targetChars: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < targetChars; index += 1) {
    const line =
      `Context stress record ${index}: the copper lighthouse tracks violet weather ` +
      `while durable state survives provider compaction.\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, targetChars);
}
