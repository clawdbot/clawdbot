import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { canonicalBytes } from "./canonical.js";
import { base64, decodeUtf8, fromBase64, fromBase64url, hex, utf8 } from "./encoding.js";
import { parseHandleEpoch } from "./identity.js";
import type { SignedReceipt } from "./receipts.js";

// Replay-store contract lives here (the leaf) so replay implementations can
// depend on envelope types without creating an import cycle.
export type ReplayClaim = "new" | "duplicate" | "mismatch" | "in_flight";

export interface CompletedReplay {
  receipt: SignedReceipt;
  body?: MessageBody;
}

export interface ReplayStore {
  claim(peer: string, id: string, envelopeHash: string): Promise<ReplayClaim>;
  /** Renews an in-flight claim while slow guard or review work is active. */
  refresh?(peer: string, id: string): Promise<void>;
  complete(peer: string, id: string, receipt: SignedReceipt, body?: MessageBody): Promise<void>;
  consume(peer: string, id: string): Promise<void>;
  release(peer: string, id: string): Promise<void>;
  completed(peer: string, id: string): Promise<CompletedReplay | undefined>;
}

export interface MessageBody {
  text: string;
  replyTo?: string;
  thread?: string;
}

export interface UnsignedEnvelope {
  v: 1;
  id: string;
  from: string;
  to: string;
  ts: number;
  epk: string;
  n: string;
  ct: string;
}

export interface Envelope extends UnsignedEnvelope {
  sig: string;
}

export type ProtocolErrorCode =
  | "bad_signature"
  | "not_pinned"
  | "wrong_recipient"
  | "expired"
  | "replayed"
  | "too_large"
  | "malformed";

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class BadSignatureError extends ProtocolError {
  constructor(message?: string) {
    super("bad_signature", message);
    this.name = "BadSignatureError";
  }
}
export class NotPinnedError extends ProtocolError {
  constructor(message?: string) {
    super("not_pinned", message);
    this.name = "NotPinnedError";
  }
}
class WrongRecipientError extends ProtocolError {
  constructor(message?: string) {
    super("wrong_recipient", message);
    this.name = "WrongRecipientError";
  }
}
export class ExpiredError extends ProtocolError {
  constructor(message?: string) {
    super("expired", message);
    this.name = "ExpiredError";
  }
}
export class ReplayedError extends ProtocolError {
  constructor(message?: string) {
    super("replayed", message);
    this.name = "ReplayedError";
  }
}
export class TooLargeError extends ProtocolError {
  constructor(message?: string) {
    super("too_large", message);
    this.name = "TooLargeError";
  }
}
export class MalformedError extends ProtocolError {
  constructor(message?: string) {
    super("malformed", message);
    this.name = "MalformedError";
  }
}

export interface SealOptions {
  id: string;
  from: string;
  to: string;
  body: MessageBody;
  senderSigningSecretKey: string;
  recipientEncryptionPublicKey: string;
  ts?: number;
  rng?: (length: number) => Uint8Array;
}

export interface OpenOptions {
  envelope: Envelope;
  self: string;
  recipientEncryptionSecretKey: string;
  senderSigningPublicKey?: string;
  replayStore: ReplayStore;
  now?: number;
  maxAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
}

export type ClaimedOpenResult =
  | { claim: "new"; body: MessageBody; envelopeHash: string }
  | { claim: "duplicate"; receipt?: SignedReceipt; body?: MessageBody };

export const REEF_MAX_PLAINTEXT_BYTES = 32 * 1024;
const MAX_CIPHERTEXT_BASE64 = 44_752;
const MAX_ENVELOPE_BYTES = 48 * 1024;
export const REEF_ENVELOPE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const HKDF_INFO = utf8("reef-v1");
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function seal(options: SealOptions): Envelope {
  validateEnvelopeMetadata(
    options.id,
    options.from,
    options.to,
    options.ts ?? Math.floor(Date.now() / 1000),
  );
  validateMessageBody(options.body);
  const plaintext = canonicalBytes(options.body);
  if (plaintext.length > REEF_MAX_PLAINTEXT_BYTES) {
    throw new TooLargeError();
  }
  const ephemeral = x25519.keygen((options.rng ?? randomBytes)(32));
  const shared = x25519.getSharedSecret(
    ephemeral.secretKey,
    decodeKey(options.recipientEncryptionPublicKey),
  );
  const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);
  const nonce = (options.rng ?? randomBytes)(12);
  if (nonce.length !== 12) {
    throw new MalformedError("rng returned invalid nonce");
  }
  const unsigned: UnsignedEnvelope = {
    v: 1,
    id: options.id,
    from: options.from,
    to: options.to,
    ts: options.ts ?? Math.floor(Date.now() / 1000),
    epk: base64(ephemeral.publicKey),
    n: base64(nonce),
    ct: base64(gcm(key, nonce).encrypt(plaintext)),
  };
  return {
    ...unsigned,
    sig: base64(ed25519.sign(canonicalBytes(unsigned), decodeKey(options.senderSigningSecretKey))),
  };
}

export async function open(options: OpenOptions): Promise<MessageBody> {
  const result = await openClaimed(options);
  if (result.claim === "duplicate") {
    throw new ReplayedError("duplicate envelope");
  }
  const peer = parseHandleEpoch(options.envelope.from).handle;
  try {
    await options.replayStore.consume(peer, options.envelope.id);
    return result.body;
  } catch (error) {
    await options.replayStore.release(peer, options.envelope.id);
    throw error;
  }
}

export async function openClaimed(options: OpenOptions): Promise<ClaimedOpenResult> {
  const envelope = validateEnvelope(options.envelope);
  if (!options.senderSigningPublicKey) {
    throw new NotPinnedError();
  }
  const { sig, ...unsigned } = envelope;
  let validSignature = false;
  try {
    validSignature = ed25519.verify(
      fromBase64(sig),
      canonicalBytes(unsigned),
      decodeKey(options.senderSigningPublicKey),
    );
  } catch {}
  if (!validSignature) {
    throw new BadSignatureError();
  }
  if (envelope.v !== 1) {
    throw new MalformedError();
  }
  validateEnvelopeMetadata(envelope.id, envelope.from, envelope.to, envelope.ts);
  if (envelope.to !== options.self) {
    throw new WrongRecipientError();
  }
  const peer = parseHandleEpoch(envelope.from).handle;
  const hash = hex(sha256(canonicalBytes(envelope)));
  const claim = await options.replayStore.claim(peer, envelope.id, hash);
  if (claim === "mismatch") {
    throw new ReplayedError("replay id binding mismatch");
  }
  if (claim === "in_flight") {
    throw new ReplayedError("in flight");
  }
  if (claim === "duplicate") {
    const completed = await options.replayStore.completed(peer, envelope.id);
    if (completed === undefined) {
      return { claim };
    }
    return completed.body === undefined
      ? { claim, receipt: completed.receipt }
      : { claim, receipt: completed.receipt, body: completed.body };
  }
  try {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const maxAge = options.maxAgeSeconds ?? REEF_ENVELOPE_MAX_AGE_SECONDS;
    const maxFutureSkew = options.maxFutureSkewSeconds ?? 300;
    if (envelope.ts > now + maxFutureSkew || envelope.ts < now - maxAge) {
      throw new ExpiredError();
    }
    const shared = x25519.getSharedSecret(
      decodeKey(options.recipientEncryptionSecretKey),
      fromBase64(envelope.epk),
    );
    const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);
    const plaintext = gcm(key, fromBase64(envelope.n)).decrypt(fromBase64(envelope.ct));
    if (plaintext.length > REEF_MAX_PLAINTEXT_BYTES) {
      throw new TooLargeError();
    }
    const body = JSON.parse(decodeUtf8(plaintext)) as unknown;
    validateMessageBody(body);
    return { claim: "new", body, envelopeHash: hash };
  } catch (error) {
    await options.replayStore.release(peer, envelope.id);
    if (error instanceof ProtocolError) {
      throw error;
    }
    throw new MalformedError();
  }
}

export function envelopeHash(envelope: Envelope): string {
  return hex(sha256(canonicalBytes(envelope)));
}

export function bodyHash(body: MessageBody): string {
  return hex(sha256(canonicalBytes(body)));
}

function decodeKey(value: string): Uint8Array {
  const key = fromBase64url(value);
  if (key.length !== 32) {
    throw new MalformedError("invalid key length");
  }
  return key;
}

export function validateEnvelopeMetadata(id: string, from: string, to: string, ts: number): void {
  if (!ULID_PATTERN.test(id) || !Number.isSafeInteger(ts) || ts < 0) {
    throw new MalformedError("invalid envelope metadata");
  }
  try {
    parseHandleEpoch(from);
    parseHandleEpoch(to);
  } catch {
    throw new MalformedError("invalid envelope peer");
  }
}

export function validateMessageBody(value: unknown): asserts value is MessageBody {
  if (!isExactObject(value, ["text", "replyTo", "thread"])) {
    throw new MalformedError("invalid body");
  }
  if (
    typeof value.text !== "string" ||
    (value.replyTo !== undefined && typeof value.replyTo !== "string") ||
    (value.thread !== undefined && typeof value.thread !== "string")
  ) {
    throw new MalformedError("invalid body");
  }
  if (
    (value.replyTo !== undefined && !ULID_PATTERN.test(value.replyTo)) ||
    (value.thread !== undefined && !ULID_PATTERN.test(value.thread))
  ) {
    throw new MalformedError("invalid body identifier");
  }
  for (const field of [value.text, value.replyTo, value.thread]) {
    if (field !== undefined && decodeUtf8(utf8(field)) !== field) {
      throw new MalformedError("invalid UTF-8 body");
    }
  }
}

function validateEnvelope(value: unknown): Envelope {
  if (!isExactObject(value, ["v", "id", "from", "to", "ts", "epk", "n", "ct", "sig"])) {
    throw new MalformedError();
  }
  if (
    typeof value.v !== "number" ||
    typeof value.id !== "string" ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    !Number.isSafeInteger(value.ts) ||
    typeof value.epk !== "string" ||
    typeof value.n !== "string" ||
    typeof value.ct !== "string" ||
    typeof value.sig !== "string"
  ) {
    throw new MalformedError();
  }
  if (value.id.length !== 26) {
    throw new MalformedError("invalid envelope id length");
  }
  if (
    value.from.length > 80 ||
    value.to.length > 80 ||
    value.epk.length > 46 ||
    value.n.length > 18 ||
    value.sig.length > 90 ||
    value.ct.length > MAX_CIPHERTEXT_BASE64
  ) {
    throw new TooLargeError();
  }
  try {
    if (
      fromBase64(value.epk).length !== 32 ||
      fromBase64(value.n).length !== 12 ||
      fromBase64(value.sig).length !== 64
    ) {
      throw new Error();
    }
    fromBase64(value.ct);
  } catch {
    throw new MalformedError();
  }
  if (canonicalBytes(value).length > MAX_ENVELOPE_BYTES) {
    throw new TooLargeError();
  }
  return value as unknown as Envelope;
}

function isExactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    Object.keys(value).every((key) => keys.includes(key)) &&
    keys.every((key) => key in value || ["replyTo", "thread"].includes(key))
  );
}
