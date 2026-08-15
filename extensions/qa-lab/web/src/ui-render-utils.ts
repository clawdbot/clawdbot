import prettyMilliseconds from "pretty-ms";

export function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatIso(iso?: string) {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(ms: number): string {
  const roundedMs = ms < 1000 ? Math.round(ms) : Math.round(ms / 1000) * 1000;
  return prettyMilliseconds(Math.max(0, roundedMs), {
    unitCount: 2,
  });
}

export function esc(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function parseJsonObject(raw?: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function statusTone(status: string): string {
  if (status === "failed") {
    return "fail";
  }
  if (status === "completed") {
    return "pass";
  }
  if (status === "skipped") {
    return "skip";
  }
  if (status === "blocked") {
    return "pending";
  }
  return status;
}

export function badgeHtml(status: string): string {
  const tone = statusTone(status);
  return `<span class="badge badge-${esc(tone)}">${esc(status)}</span>`;
}
