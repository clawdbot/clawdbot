export const GATEWAY_CLIENT_CAPS: Record<string, string>;
export const GATEWAY_CLIENT_IDS: Record<string, string>;
export const GATEWAY_CLIENT_MODES: Record<string, string>;
export const MIN_CLIENT_PROTOCOL_VERSION: number;
export const PROTOCOL_VERSION: number;

export const ed25519Utils: {
  randomSecretKey(): Uint8Array;
};
export function getPublicKeyAsync(secretKey: Uint8Array): Promise<Uint8Array>;
export function signAsync(message: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array>;

export class GatewayProtocolRequestError extends Error {
  constructor(error: Record<string, unknown>);
}

export class GatewayProtocolClient {
  constructor(options: Record<string, unknown>);
  start(): void;
  stop(): void;
  request(method: string, params: unknown, options?: unknown): Promise<unknown>;
}

export class GatewayBrowserDeviceAuthLifecycle {
  constructor(options: Record<string, unknown>);
  buildPlan(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  acceptHello(hello: unknown, plan: unknown): Promise<void>;
  clearStoredToken(plan: unknown): Promise<void>;
}
