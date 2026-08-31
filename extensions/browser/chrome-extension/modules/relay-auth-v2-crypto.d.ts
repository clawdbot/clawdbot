export const RELAY_AUTH_VERSION: 2;
export function requireRelayCrypto(cryptoApi: Crypto): Crypto;
export function relayBytesFromBase64Url(
  value: unknown,
  expectedLength: number,
  field: string,
): Uint8Array;
export function randomRelayBase64Url(cryptoApi: Crypto, byteLength: number): string;
export function extensionRelayAuthResource(relayUrl: string): string;
export type RelayAuthProofFields = {
  keyId: string;
  instanceId: string;
  sessionId: string;
  clientNonce: string;
  serverNonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  role: string;
  transport: string;
  method: string;
  resource: string;
  flow: string;
};
export function canonicalRelayAuthProofBytes(
  proofKind: "server" | "client" | "accept",
  fields: RelayAuthProofFields,
  clientProof?: string,
): Uint8Array;
export function importRelayHmacKey(token: string, cryptoApi: Crypto): Promise<CryptoKey>;
export function deriveRelayAuthKeyId(token: string, cryptoApi?: Crypto): Promise<string>;
export function computeRelayAuthProof(
  token: string,
  proofKind: "server" | "client" | "accept",
  fields: RelayAuthProofFields,
  clientProof?: string,
  cryptoApi?: Crypto,
): Promise<string>;
