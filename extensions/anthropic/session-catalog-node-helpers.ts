export function createNodeListFailedError(error: unknown): { code: string; message: string } {
  const detail =
    error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  const summary = "Paired nodes could not be listed";
  return {
    code: "NODE_LIST_FAILED",
    message: detail && detail !== summary ? `${summary}: ${detail}` : summary,
  };
}

export function resolveNodeLabel(node: {
  displayName?: string;
  remoteIp?: string;
  nodeId: string;
}): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}
