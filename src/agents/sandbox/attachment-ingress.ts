import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { hashTextSha256 } from "./hash.js";

/** Host-private root reserved for attachment ingress outside agent workspaces. */
export function resolveSandboxAttachmentIngressRoot(): string {
  return path.join(resolveStateDir(), "attachment-ingress");
}

export function resolveSandboxAttachmentIngressWorkspace(sessionKey: string): string {
  return path.join(resolveSandboxAttachmentIngressRoot(), hashTextSha256(sessionKey).slice(0, 32));
}
