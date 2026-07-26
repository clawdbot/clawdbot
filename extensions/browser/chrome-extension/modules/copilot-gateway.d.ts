type StorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(update: Record<string, unknown>): Promise<void>;
};

export function isDefinitiveGatewayRejection(error: unknown): boolean;
export function waitForCopilotGatewayReady(
  client: CopilotGatewayClient,
  gatewayScope: string,
): Promise<void>;

export class CopilotGatewayClient {
  constructor(options?: { storage?: StorageArea; WebSocketImpl?: typeof WebSocket });
  ready: boolean;
  hello: Record<string, unknown> | null;
  onEvent(listener: (event: unknown) => void): () => void;
  onStatus(listener: (status: Record<string, unknown>) => void): () => void;
  start(url: string): void;
  stop(): void;
  request(method: string, params: unknown, options?: unknown): Promise<unknown>;
}
