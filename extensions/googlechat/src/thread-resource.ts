export const GOOGLE_CHAT_THREAD_RESOURCE_RE = /^spaces\/[^/]+\/threads\/[^/]+$/;

export function isGoogleChatThreadResourceName(value: string | undefined): boolean {
  return typeof value === "string" && GOOGLE_CHAT_THREAD_RESOURCE_RE.test(value);
}
