/** Formats user-home paths compactly for approval prompts without normalizing unsafe paths. */
export function formatApprovalDisplayPath(value: string): string {
  const normalized = value.trim();
  if (!normalized || hasRelativePathSegment(normalized)) {
    return normalized;
  }

  const unixHomeMatch = normalized.match(/^\/(?:home|Users)\/([^/]+)(.*)$/);
  if (unixHomeMatch && isSafeHomeSegment(unixHomeMatch[1])) {
    // Use display-only home compaction for both Linux and macOS paths; approval matching still uses
    // the original path value.
    return compactHomeSuffix(unixHomeMatch[2] ?? "");
  }

  const windowsHomeMatch = normalized.match(/^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)(.*)$/i);
  if (windowsHomeMatch && isSafeHomeSegment(windowsHomeMatch[1])) {
    // Normalize slashes only after proving this is a plain Windows user-home path.
    return compactHomeSuffix(windowsHomeMatch[2] ?? "");
  }

  return normalized;
}

function compactHomeSuffix(suffix: string): string {
  return `~${suffix.replace(/\\/g, "/")}`;
}

function isSafeHomeSegment(segment: string | undefined): boolean {
  return segment !== undefined && segment !== "." && segment !== "..";
}

function hasRelativePathSegment(value: string): boolean {
  // Do not compact paths containing `.` or `..`; hiding those segments would make approval prompts
  // less precise than the path that will actually be evaluated.
  return /(^|[\\/])\.{1,2}(?=[\\/]|$)/.test(value);
}
