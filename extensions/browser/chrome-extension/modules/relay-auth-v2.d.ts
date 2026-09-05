export const EXTENSION_RELAY_V2_PROTOCOL: string;
export function parseRelayAuthJson(raw: string): Record<string, unknown> | null;
export function createExtensionRelayAuthClient(params: {
  token: string;
  relayUrl: string;
  cryptoApi?: Crypto;
  now?: () => number;
  clientNonce?: string;
}): Promise<{
  readonly keyId: string;
  readonly clientNonce: string;
  readonly authenticated: boolean;
  start(): { type: "auth.hello"; v: 2; keyId: string; clientNonce: string };
  acceptChallenge(message: unknown): Promise<{
    type: "auth.response";
    v: 2;
    sessionId: string;
    clientProof: string;
  }>;
  acceptOk(message: unknown): Promise<void>;
}>;
