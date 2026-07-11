export type GatewayFrame = {
  error?: {
    code?: string;
    details?: Record<string, unknown>;
    message?: string;
    retryable?: boolean;
  };
  id?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  type?: string;
};
export type GatewaySocket = { close(): void; send(payload: string): void };
export function assertReadySuspensionResponse(
  response: Record<string, unknown>,
  now?: number,
): Record<string, unknown>;
export function assertGatewaySuspendingError(response: GatewayFrame): void;
export function assertSuspendedProbes(
  health: Record<string, unknown>,
  readiness: Record<string, unknown>,
): void;
export function responseError(method: string, response: GatewayFrame): Error;
export function runGatewayNetworkClient(
  options: { token: string; url: string; timeoutMs?: number },
  deps?: {
    delay?: (ms: number) => Promise<void>;
    onceFrame?: (
      ws: GatewaySocket,
      predicate: (message: GatewayFrame) => boolean,
      timeoutMs?: number,
    ) => Promise<GatewayFrame>;
    openSocket?: (url: string, timeoutMs?: number) => Promise<GatewaySocket>;
    protocolVersion?: number;
    stdout?: (message: string) => void;
  },
): Promise<void>;
