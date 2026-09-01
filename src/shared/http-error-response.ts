const HTML_ERROR_PREFIX_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;

export function extractHttpResponseBody(
  status: { code: number; rest: string } | null,
): { code: number; body: string } | null {
  if (!status) {
    return null;
  }
  if (HTML_ERROR_PREFIX_RE.test(status.rest)) {
    return { code: status.code, body: status.rest };
  }
  const lineBreak = status.rest.indexOf("\n");
  return {
    code: status.code,
    body: lineBreak === -1 ? status.rest : status.rest.slice(lineBreak + 1).trimStart(),
  };
}
