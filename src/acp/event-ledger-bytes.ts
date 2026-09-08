/** Retained UTF-8 text footprint, including the existing fixed allowance per row. */
export function estimateAcpSessionRowBytes(params: {
  sessionId: string;
  sessionKey: string;
  cwd: string;
}): number {
  return (
    Buffer.byteLength(params.sessionId, "utf8") +
    Buffer.byteLength(params.sessionKey, "utf8") +
    Buffer.byteLength(params.cwd, "utf8") +
    32
  );
}

export function estimateAcpEventRowBytes(params: {
  sessionId: string;
  sessionKey: string;
  runId?: string | null;
  updateJson: string;
}): number {
  // Measure fields separately: lone surrogates across columns must not combine.
  return (
    Buffer.byteLength(params.sessionId, "utf8") +
    Buffer.byteLength(params.sessionKey, "utf8") +
    Buffer.byteLength(params.runId ?? "", "utf8") +
    Buffer.byteLength(params.updateJson, "utf8") +
    32
  );
}
