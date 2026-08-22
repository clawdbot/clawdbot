import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

const RFB_VERSION_BYTES = 12;
const RFB_3_3_VERSION = Buffer.from("RFB 003.003\n", "ascii");
const RFB_3_8_VERSION = Buffer.from("RFB 003.008\n", "ascii");
const RFB_SECURITY_NONE = 1;
const RFB_SECURITY_VNC = 2;
const RFB_SECURITY_ARD = 30;
const MAX_ARD_KEY_BYTES = 1024;
const MAX_REASON_BYTES = 64 * 1024;
const DEFAULT_PREAUTH_TIMEOUT_MS = 10_000;

export type RfbPreauthDescriptor =
  | {
      auth: "ard-account";
      credentials: { username: string; password: string };
    }
  | {
      auth: "vnc-password";
      credentials: { password: string };
    };

export type RfbPreauthPeer = {
  readExactly(length: number, signal: AbortSignal): Promise<Buffer>;
  write(buffer: Buffer, signal: AbortSignal): Promise<void>;
};

export class RfbPreauthTimeoutError extends Error {
  constructor() {
    super("RFB authentication negotiation timed out");
    this.name = "RfbPreauthTimeoutError";
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("RFB authentication negotiation aborted");
}

/** Exact-byte queue shared by stream and WebSocket handshake adapters. */
export class RfbPreauthBuffer {
  private buffered = Buffer.alloc(0);
  private failure: Error | undefined;
  private readonly waiters = new Set<() => void>();

  push(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }

  private async waitForData(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(onWake);
        signal.removeEventListener("abort", onAbort);
      };
      const onWake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(abortReason(signal));
      };
      this.waiters.add(onWake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async readExactly(length: number, signal: AbortSignal): Promise<Buffer> {
    while (this.buffered.length < length) {
      if (this.failure) {
        throw this.failure;
      }
      await this.waitForData(signal);
    }
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }

  takeBuffered(): Buffer {
    const value = this.buffered;
    this.buffered = Buffer.alloc(0);
    return value;
  }
}

class StreamRfbPreauthPeer implements RfbPreauthPeer {
  private readonly reader = new RfbPreauthBuffer();

  private readonly onData = (chunk: Buffer) => this.reader.push(chunk);
  private readonly onEnd = () => {
    this.reader.fail(new Error("RFB peer closed during authentication negotiation"));
  };
  private readonly onError = (error: Error) => {
    this.reader.fail(error);
  };

  constructor(private readonly stream: Duplex) {
    stream.on("data", this.onData);
    stream.once("end", this.onEnd);
    stream.once("close", this.onEnd);
    stream.once("error", this.onError);
  }

  async readExactly(length: number, signal: AbortSignal): Promise<Buffer> {
    return await this.reader.readExactly(length, signal);
  }

  async write(buffer: Buffer, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.stream.write(buffer, (error) => {
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  dispose(): void {
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.off("close", this.onEnd);
    this.stream.off("error", this.onError);
  }
}

function parseServerVersion(banner: Buffer): { minor: number; reply: Buffer } {
  const match = /^RFB 003\.(\d{3})\n$/u.exec(banner.toString("ascii"));
  if (!match) {
    throw new Error(`unsupported RFB protocol version ${JSON.stringify(banner.toString("ascii"))}`);
  }
  const offeredMinor = Number.parseInt(match[1] ?? "", 10);
  if (offeredMinor === 889 || offeredMinor >= 7) {
    return { minor: 8, reply: RFB_3_8_VERSION };
  }
  return { minor: 3, reply: RFB_3_3_VERSION };
}

async function readReason(peer: RfbPreauthPeer, signal: AbortSignal): Promise<string> {
  const length = (await peer.readExactly(4, signal)).readUInt32BE(0);
  if (length === 0) {
    return "";
  }
  if (length > MAX_REASON_BYTES) {
    throw new Error("RFB failure reason is too large");
  }
  return (await peer.readExactly(length, signal)).toString("utf8");
}

async function selectSecurityType(params: {
  peer: RfbPreauthPeer;
  protocolMinor: number;
  requiredType: number;
  signal: AbortSignal;
}): Promise<void> {
  if (params.protocolMinor < 7) {
    const selected = (await params.peer.readExactly(4, params.signal)).readUInt32BE(0);
    if (selected === 0) {
      const reason = await readReason(params.peer, params.signal);
      throw new Error(`RFB server rejected security negotiation${reason ? `: ${reason}` : ""}`);
    }
    if (selected !== params.requiredType) {
      throw new Error(`RFB server selected security type ${selected}, want ${params.requiredType}`);
    }
    return;
  }

  const count = (await params.peer.readExactly(1, params.signal))[0] ?? 0;
  if (count === 0) {
    const reason = await readReason(params.peer, params.signal);
    throw new Error(`RFB server rejected security negotiation${reason ? `: ${reason}` : ""}`);
  }
  const offered = await params.peer.readExactly(count, params.signal);
  if (!offered.includes(params.requiredType)) {
    throw new Error(
      `RFB server did not offer required security type ${params.requiredType} (offered ${[
        ...offered,
      ].join(", ")})`,
    );
  }
  await params.peer.write(Buffer.from([params.requiredType]), params.signal);
}

function bufferToBigInt(value: Buffer): bigint {
  return value.length === 0 ? 0n : BigInt(`0x${value.toString("hex")}`);
}

function leftPadBigInt(value: bigint, length: number): Buffer {
  const hex = value.toString(16).padStart(2, "0");
  let bytes = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
  if (bytes.length > length) {
    bytes = bytes.subarray(bytes.length - length);
  }
  const output = Buffer.alloc(length);
  bytes.copy(output, length - bytes.length);
  return output;
}

function modularExponentiation(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) {
    throw new Error("invalid ARD Diffie-Hellman modulus");
  }
  let result = 1n;
  let factor = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if ((power & 1n) === 1n) {
      result = (result * factor) % modulus;
    }
    factor = (factor * factor) % modulus;
    power >>= 1n;
  }
  return result;
}

function buildArdCredentialsBlock(username: string, password: string): Buffer {
  const block = randomBytes(128);
  const usernameBytes = Buffer.from(username, "utf8").subarray(0, 63);
  const passwordBytes = Buffer.from(password, "utf8").subarray(0, 63);
  usernameBytes.copy(block, 0);
  block[usernameBytes.length] = 0;
  passwordBytes.copy(block, 64);
  block[64 + passwordBytes.length] = 0;
  return block;
}

function encryptAesEcb(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

async function negotiateArdAuth(params: {
  peer: RfbPreauthPeer;
  credentials: { username: string; password: string };
  signal: AbortSignal;
}): Promise<void> {
  const header = await params.peer.readExactly(4, params.signal);
  const keyLength = header.readUInt16BE(2);
  if (keyLength < 1 || keyLength > MAX_ARD_KEY_BYTES) {
    throw new Error(`invalid ARD key length ${keyLength}`);
  }
  const dhParameters = await params.peer.readExactly(keyLength * 2, params.signal);
  const generator = bufferToBigInt(header.subarray(0, 2));
  const modulus = bufferToBigInt(dhParameters.subarray(0, keyLength));
  const serverPublic = bufferToBigInt(dhParameters.subarray(keyLength));
  if (generator === 0n || modulus === 0n || serverPublic === 0n) {
    throw new Error("invalid ARD Diffie-Hellman parameters");
  }

  const privateKey = bufferToBigInt(randomBytes(keyLength));
  const clientPublic = modularExponentiation(generator, privateKey, modulus);
  const shared = modularExponentiation(serverPublic, privateKey, modulus);
  // MD5 and AES-ECB are mandated by ARD/RFB wire compatibility; they do not protect stored data.
  const key = createHash("md5").update(leftPadBigInt(shared, keyLength)).digest();
  const encryptedCredentials = encryptAesEcb(
    key,
    buildArdCredentialsBlock(params.credentials.username, params.credentials.password),
  );
  await params.peer.write(
    Buffer.concat([encryptedCredentials, leftPadBigInt(clientPublic, keyLength)]),
    params.signal,
  );
}

function reverseByteBits(value: number): number {
  let input = value;
  let output = 0;
  for (let index = 0; index < 8; index += 1) {
    output = (output << 1) | (input & 1);
    input >>= 1;
  }
  return output;
}

function buildVncAuthResponse(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "utf8").copy(key, 0, 0, 8);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = reverseByteBits(key[index] ?? 0);
  }
  // RFB mandates single DES. EDE with K1=K2 is the same primitive on OpenSSL builds without des-ecb.
  const cipher = createCipheriv("des-ede", Buffer.concat([key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

async function negotiateVncAuth(params: {
  peer: RfbPreauthPeer;
  password: string;
  signal: AbortSignal;
}): Promise<void> {
  if (!params.password) {
    throw new Error("VNC password is required");
  }
  const challenge = await params.peer.readExactly(16, params.signal);
  await params.peer.write(buildVncAuthResponse(params.password, challenge), params.signal);
}

async function readSecurityResult(peer: RfbPreauthPeer, signal: AbortSignal): Promise<void> {
  const status = (await peer.readExactly(4, signal)).readUInt32BE(0);
  if (status === 0) {
    return;
  }
  let reason = "";
  try {
    reason = await readReason(peer, signal);
  } catch {
    // Older servers may close immediately after the status word.
  }
  throw new Error(
    reason
      ? `RFB authentication failed: ${reason}`
      : `RFB authentication failed with status ${status}`,
  );
}

async function negotiateServer(params: {
  peer: RfbPreauthPeer;
  preauth: RfbPreauthDescriptor;
  signal: AbortSignal;
}): Promise<void> {
  if (
    params.preauth.auth === "ard-account" &&
    (!params.preauth.credentials.username || !params.preauth.credentials.password)
  ) {
    throw new Error("ARD account username and password are required");
  }
  const banner = await params.peer.readExactly(RFB_VERSION_BYTES, params.signal);
  const version = parseServerVersion(banner);
  await params.peer.write(version.reply, params.signal);
  const requiredType = params.preauth.auth === "ard-account" ? RFB_SECURITY_ARD : RFB_SECURITY_VNC;
  await selectSecurityType({
    peer: params.peer,
    protocolMinor: version.minor,
    requiredType,
    signal: params.signal,
  });
  if (params.preauth.auth === "ard-account") {
    await negotiateArdAuth({
      peer: params.peer,
      credentials: params.preauth.credentials,
      signal: params.signal,
    });
  } else {
    await negotiateVncAuth({
      peer: params.peer,
      password: params.preauth.credentials.password,
      signal: params.signal,
    });
  }
  await readSecurityResult(params.peer, params.signal);
}

async function synthesizeBrowserHandshake(
  browser: RfbPreauthPeer,
  signal: AbortSignal,
): Promise<void> {
  await browser.write(RFB_3_8_VERSION, signal);
  const version = await browser.readExactly(RFB_VERSION_BYTES, signal);
  if (!version.equals(RFB_3_8_VERSION)) {
    throw new Error("RFB browser did not accept protocol version 3.8");
  }
  await browser.write(Buffer.from([1, RFB_SECURITY_NONE]), signal);
  const selected = await browser.readExactly(1, signal);
  if (selected[0] !== RFB_SECURITY_NONE) {
    throw new Error("RFB browser did not select no authentication");
  }
  await browser.write(Buffer.alloc(4), signal);
}

/** Authenticates the Gateway to an RFB server, then exposes a synthetic None handshake. */
export async function preauthenticateRfb(params: {
  server: Duplex;
  browser: RfbPreauthPeer;
  preauth: RfbPreauthDescriptor;
  timeoutMs?: number;
}): Promise<void> {
  const server = new StreamRfbPreauthPeer(params.server);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new RfbPreauthTimeoutError()),
    params.timeoutMs ?? DEFAULT_PREAUTH_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    await negotiateServer({ peer: server, preauth: params.preauth, signal: controller.signal });
    await synthesizeBrowserHandshake(params.browser, controller.signal);
  } finally {
    clearTimeout(timeout);
    server.dispose();
  }
}
