// Convert a node-host error payload to a thrown Error for agent-tool consumption.
// The agent-tool surfaces these as failed tool results uniformly.
export function throwFromNodePayload(operation: string, payload: Record<string, unknown>): never {
  const code = typeof payload.code === "string" ? payload.code : "ERROR";
  const message = typeof payload.message === "string" ? payload.message : `${operation} failed`;
  const canonical =
    typeof payload.canonicalPath === "string" ? ` (canonical=${payload.canonicalPath})` : "";
  throw new Error(`${operation} ${code}: ${message}${canonical}`);
}
