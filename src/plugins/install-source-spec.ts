import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export function resolveFileNpmSpecToLocalPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file:")) {
    return null;
  }
  const rest = trimmed.slice("file:".length);
  if (!rest) {
    return { ok: false, error: "unsupported file: spec: missing path" };
  }
  if (rest.startsWith("///")) {
    return { ok: true, path: rest.slice(2) };
  }
  if (rest.startsWith("//localhost/")) {
    return { ok: true, path: rest.slice("//localhost".length) };
  }
  if (rest.startsWith("//")) {
    return {
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    };
  }
  return { ok: true, path: rest };
}

export function parseNpmPrefixSpec(raw: string): string | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm:")) {
    return null;
  }
  return trimmed.slice("npm:".length).trim();
}

export function parseNpmPackPrefixPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm-pack:")) {
    return null;
  }
  return trimmed.slice("npm-pack:".length).trim();
}
