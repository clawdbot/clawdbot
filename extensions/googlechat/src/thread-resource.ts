export const GOOGLE_CHAT_THREAD_RESOURCE_RE = /^spaces\/[^/]+\/threads\/[^/]+$/;
export const GOOGLE_CHAT_MESSAGE_RESOURCE_RE = /^spaces\/[^/]+\/messages\/[^/]+$/;

export function isGoogleChatThreadResourceName(value: string | null | undefined): boolean {
  return typeof value === "string" && GOOGLE_CHAT_THREAD_RESOURCE_RE.test(value);
}

export function isGoogleChatMessageResourceName(value: string | null | undefined): boolean {
  return typeof value === "string" && GOOGLE_CHAT_MESSAGE_RESOURCE_RE.test(value);
}
