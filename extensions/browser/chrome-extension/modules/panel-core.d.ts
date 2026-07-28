export type BrowserCopilotBinding = {
  kind: "tab";
  tabId: number;
  target: "host";
  profile: string;
  targetId: string;
};

export type ChatStream = {
  runId: string | null;
  full: string;
  segmentStart: number;
};

export function deriveTabSessionKey(mainSessionKey: unknown, sessionId: unknown): string | null;
export function gatewayUrlFromPairing(
  relayUrl: unknown,
  explicitGatewayUrl: unknown,
): string | null;
export function normalizeGatewayUrl(raw: unknown): string | null;
export function buildCopilotChatSendParams(params: {
  binding: BrowserCopilotBinding;
  message: string;
  sessionId?: string;
  sessionKey: string;
}): {
  sessionKey: string;
  sessionId?: string;
  message: string;
  idempotencyKey: string;
  deliver: false;
  toolBindings: { browser: BrowserCopilotBinding };
};
export function createChatStream(): ChatStream;
export function resetChatStream(stream: ChatStream): void;
export function applyChatDelta(
  stream: ChatStream,
  payload: unknown,
): { text: string; newBubble: boolean } | null;
export function renderMarkdownLite(text: unknown): string;
export function readMessageText(message: unknown): string;
