export function formatMs(ms?: number | null): string {
  if (!ms && ms !== 0) return "n/a";
  return new Date(ms).toLocaleString();
}

export function formatAgo(ms?: number | null): string {
  if (!ms && ms !== 0) return "n/a";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function formatDurationMs(ms?: number | null): string {
  if (!ms && ms !== 0) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.round(hr / 24);
  return `${day}d`;
}

export function formatList(values?: Array<string | null | undefined>): string {
  if (!values || values.length === 0) return "none";
  return values.filter((v): v is string => Boolean(v && v.trim())).join(", ");
}

export function clampText(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function truncateText(value: string, max: number): {
  text: string;
  truncated: boolean;
  total: number;
} {
  if (value.length <= max) {
    return { text: value, truncated: false, total: value.length };
  }
  return {
    text: value.slice(0, Math.max(0, max)),
    truncated: true,
    total: value.length,
  };
}

export function toNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|final)\s*>/gi;
const THINKING_OPEN_RE = /<\s*(?:think(?:ing)?|final)\s*>/i;
const THINKING_CLOSE_RE = /<\s*\/\s*(?:think(?:ing)?|final)\s*>/i;

export function stripThinkingTags(value: string): string {
  if (!value) return value;
  const hasOpen = THINKING_OPEN_RE.test(value);
  const hasClose = THINKING_CLOSE_RE.test(value);
  if (!hasOpen && !hasClose) return value;
  // If we don't have a balanced pair, avoid dropping trailing content.
  if (hasOpen !== hasClose) {
    if (!hasOpen) return value.replace(THINKING_CLOSE_RE, "").trimStart();
    return value.replace(THINKING_OPEN_RE, "").trimStart();
  }

  if (!THINKING_TAG_RE.test(value)) return value;
  THINKING_TAG_RE.lastIndex = 0;

  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  for (const match of value.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    if (!inThinking) {
      result += value.slice(lastIndex, idx);
    }
    const tag = match[0].toLowerCase();
    inThinking = !tag.includes("/");
    lastIndex = idx + match[0].length;
  }
  if (!inThinking) {
    result += value.slice(lastIndex);
  }
  return result.trimStart();
}
