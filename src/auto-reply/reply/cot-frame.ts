type CotFramePrefixOptions = {
  speakerLabels?: readonly string[];
};

const COT_FRAME_PREFIX_RE = /^\s*\[([^\]\r\n]{1,80})\]/u;

const DEFAULT_INTERNAL_FRAME_PREFIXES = [
  "analysis",
  "chain of thought",
  "cot",
  "internal",
  "private",
  "reasoning",
  "scratchpad",
  "thinking",
  "thought",
] as const;

const COMMON_VISIBLE_LABELS = new Set(["assistant", "info", "system", "todo", "tool", "user"]);

function normalizeFrameLabel(label: string): string {
  return label
    .trim()
    .replace(/[\s_-]+/g, " ")
    .toLowerCase();
}

function labelMatchesPrefix(label: string, prefix: string): boolean {
  return (
    label === prefix ||
    label.startsWith(`${prefix} `) ||
    label.startsWith(`${prefix}:`) ||
    label.startsWith(`${prefix} -`)
  );
}

export function hasCotFramePrefix(text: string, options: CotFramePrefixOptions = {}): boolean {
  if (!text) {
    return false;
  }
  const match = COT_FRAME_PREFIX_RE.exec(text);
  if (!match) {
    return false;
  }

  const label = normalizeFrameLabel(match[1] ?? "");
  if (!label || COMMON_VISIBLE_LABELS.has(label)) {
    return false;
  }

  if (options.speakerLabels?.some((speakerLabel) => normalizeFrameLabel(speakerLabel) === label)) {
    return true;
  }

  return DEFAULT_INTERNAL_FRAME_PREFIXES.some((prefix) => labelMatchesPrefix(label, prefix));
}
