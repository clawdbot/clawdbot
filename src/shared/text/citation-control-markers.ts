const UNSUPPORTED_CITATION_CONTROL_MARKER_RE = /cite(?:[^]*)?/g;
const TRAILING_UNSUPPORTED_CITATION_CONTROL_MARKER_RE = /[ \t]*cite(?:[^]*)?(?=\r?\n|$)/g;

/** Removes unsupported model citation-control markers without disturbing normal hard breaks. */
export function stripUnsupportedCitationControlMarkers(text: string): string {
  return text
    .replace(TRAILING_UNSUPPORTED_CITATION_CONTROL_MARKER_RE, "")
    .replace(UNSUPPORTED_CITATION_CONTROL_MARKER_RE, "");
}
