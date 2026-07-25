// Terminal Core module implements links behavior.
import { formatTerminalLink } from "./terminal-link.js";

function resolveDocsRoot(): string {
  return "https://docs.openclaw.ai";
}

const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//i;

export function formatDocsLink(
  path: string | undefined | null,
  label?: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const docsRoot = resolveDocsRoot();
  const trimmed = typeof path === "string" ? path.trim() : "";
  // When a caller has no docsPath, link to the docs root rather than crashing
  // the onboarding/channel-selection flows that pass meta.docsPath through
  // here unguarded. The typed contract says docsPath is required, but a
  // handful of channel plugins and catalog rows leave it unset at runtime.
  const url = trimmed
    ? ABSOLUTE_HTTP_URL_RE.test(trimmed)
      ? trimmed
      : `${docsRoot}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`
    : docsRoot;
  return formatTerminalLink(label ?? url, url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}
