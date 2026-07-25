// Approval kind is shared by exec and plugin approval routing surfaces.
export type ChannelApprovalKind = "exec" | "plugin";

/** Resolve approval ownership from the typed request payload, never from id spelling. */
export function resolveApprovalRequestKind(request: { request: object }): ChannelApprovalKind {
  const isExec = "command" in request.request;
  const isPlugin = "title" in request.request && "description" in request.request;
  if (isExec === isPlugin) {
    throw new Error("approval request payload does not identify exactly one owner");
  }
  if (isExec) {
    return "exec";
  }
  return "plugin";
}
