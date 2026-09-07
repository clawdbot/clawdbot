export function openAuthenticatedRelaySocket(params: {
  relayUrl: string;
  token: string;
  isCurrent: (socket: WebSocket) => boolean;
  onAuthenticated: (socket: WebSocket) => void | Promise<void>;
  onApplicationMessage: (socket: WebSocket, message: Record<string, unknown>) => void;
  onAuthenticationFailure: (socket: WebSocket, error: unknown) => void;
  onClose: (socket: WebSocket, authenticated: boolean) => void;
}): WebSocket;
