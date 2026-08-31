export const BROWSER_PROXY_COMMAND = "browser.proxy";
export const BROWSER_PROXY_UPLOAD_COMMAND = "browser.proxy.upload.v1";

export function browserProxyUploadUnavailableMessage(
  pendingDeclaredCommands: readonly string[] | undefined,
): string {
  return pendingDeclaredCommands?.includes(BROWSER_PROXY_UPLOAD_COMMAND)
    ? "browser node remote upload transfer is pending approval; approve the node's pending command update before retrying"
    : "browser node does not support remote upload transfer; update the node or approve its pending command update before retrying";
}
