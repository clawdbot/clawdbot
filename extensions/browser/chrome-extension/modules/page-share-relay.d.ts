import type { PageSharePayload } from "./page-share-core.js";

export type PageShareRelayResult = {
  requestId: number;
  ok: boolean;
  error?: string;
};

export type PageShareRelay = {
  rejectSocket(socket: WebSocket): void;
  send(socket: WebSocket, payload: PageSharePayload): Promise<void>;
  settle(socket: WebSocket, result: PageShareRelayResult): void;
};

export function createPageShareRelay(): PageShareRelay;
