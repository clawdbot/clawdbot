import { createDecipheriv, createHash } from "node:crypto";
import { type Duplex, duplexPair } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  preauthenticateRfb,
  type RfbPreauthDescriptor,
  type RfbPreauthPeer,
} from "./rfb-preauth.js";

const VERSION_3_8 = Buffer.from("RFB 003.008\n", "ascii");

class ScriptedPeer implements RfbPreauthPeer {
  private buffered = Buffer.alloc(0);
  private failure: Error | undefined;
  private readonly waiters = new Set<() => void>();

  constructor(readonly stream: Duplex) {
    stream.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.wake();
    });
    stream.once("error", (error) => {
      this.failure = error;
      this.wake();
    });
    stream.once("close", () => {
      this.failure = new Error("scripted peer closed");
      this.wake();
    });
  }

  private wake(): void {
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }

  async readExactly(length: number, signal?: AbortSignal): Promise<Buffer> {
    while (this.buffered.length < length) {
      if (this.failure) {
        throw this.failure;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.waiters.delete(onWake);
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error("scripted RFB negotiation aborted"),
          );
        };
        const onWake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        this.waiters.add(onWake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }

  async write(buffer: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.write(buffer, (error) => (error ? reject(error) : resolve()));
    });
  }
}

function bigIntBuffer(value: bigint, length: number): Buffer {
  const hex = value.toString(16);
  const bytes = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
  const result = Buffer.alloc(length);
  bytes.copy(result, length - bytes.length);
  return result;
}

function bufferBigInt(value: Buffer): bigint {
  return BigInt(`0x${value.toString("hex")}`);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
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

async function completeSyntheticBrowserHandshake(browser: ScriptedPeer): Promise<void> {
  expect(await browser.readExactly(12)).toEqual(VERSION_3_8);
  await browser.write(VERSION_3_8);
  expect(await browser.readExactly(2)).toEqual(Buffer.from([1, 1]));
  await browser.write(Buffer.from([1]));
  expect(await browser.readExactly(4)).toEqual(Buffer.alloc(4));
}

async function runPreauth(params: {
  preauth: RfbPreauthDescriptor;
  serverScript: (server: ScriptedPeer) => Promise<void>;
}): Promise<void> {
  const [gatewayServer, fakeServerStream] = duplexPair();
  const [gatewayBrowserStream, fakeBrowserStream] = duplexPair();
  const gatewayBrowser = new ScriptedPeer(gatewayBrowserStream);
  const fakeServer = new ScriptedPeer(fakeServerStream);
  const fakeBrowser = new ScriptedPeer(fakeBrowserStream);
  try {
    await Promise.all([
      preauthenticateRfb({
        server: gatewayServer,
        browser: gatewayBrowser,
        preauth: params.preauth,
      }),
      params.serverScript(fakeServer),
      completeSyntheticBrowserHandshake(fakeBrowser),
    ]);
  } finally {
    gatewayServer.destroy();
    fakeServerStream.destroy();
    gatewayBrowserStream.destroy();
    fakeBrowserStream.destroy();
  }
}

async function writeArdOffer(server: ScriptedPeer, keyLength: number): Promise<void> {
  await server.write(Buffer.from("RFB 003.889\n", "ascii"));
  expect(await server.readExactly(12)).toEqual(VERSION_3_8);
  await server.write(Buffer.from([4, 30, 33, 36, 35]));
  expect(await server.readExactly(1)).toEqual(Buffer.from([30]));
  const generator = 5n;
  const modulus = 7919n;
  const serverPrivate = 7n;
  const serverPublic = modPow(generator, serverPrivate, modulus);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(Number(generator), 0);
  header.writeUInt16BE(keyLength, 2);
  await server.write(
    Buffer.concat([
      header,
      bigIntBuffer(modulus, keyLength),
      bigIntBuffer(serverPublic, keyLength),
    ]),
  );
}

describe("RFB server-side pre-authentication", () => {
  it.each([16, 32])(
    "negotiates ARD framing and encrypted credentials at %i bytes",
    async (keyLength) => {
      const username = "screen-user";
      const password = "screen-password";
      await runPreauth({
        preauth: { auth: "ard-account", credentials: { username, password } },
        serverScript: async (server) => {
          await writeArdOffer(server, keyLength);
          const response = await server.readExactly(128 + keyLength);
          expect(response).toHaveLength(128 + keyLength);

          const modulus = 7919n;
          const serverPrivate = 7n;
          const clientPublic = bufferBigInt(response.subarray(128));
          const shared = modPow(clientPublic, serverPrivate, modulus);
          const key = createHash("md5").update(bigIntBuffer(shared, keyLength)).digest();
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          decipher.setAutoPadding(false);
          const plaintext = Buffer.concat([
            decipher.update(response.subarray(0, 128)),
            decipher.final(),
          ]);
          expect(plaintext.subarray(0, username.length).toString("utf8")).toBe(username);
          expect(plaintext[username.length]).toBe(0);
          expect(plaintext.subarray(64, 64 + password.length).toString("utf8")).toBe(password);
          expect(plaintext[64 + password.length]).toBe(0);
          await server.write(Buffer.alloc(4));
        },
      });
    },
  );

  it.each([0, 1025])("rejects malformed ARD key length %i", async (keyLength) => {
    const [gatewayServer, fakeServerStream] = duplexPair();
    const [gatewayBrowserStream, fakeBrowserStream] = duplexPair();
    const fakeServer = new ScriptedPeer(fakeServerStream);
    const preauth = preauthenticateRfb({
      server: gatewayServer,
      browser: new ScriptedPeer(gatewayBrowserStream),
      preauth: {
        auth: "ard-account",
        credentials: { username: "operator", password: "password" },
      },
    });
    try {
      await fakeServer.write(VERSION_3_8);
      expect(await fakeServer.readExactly(12)).toEqual(VERSION_3_8);
      await fakeServer.write(Buffer.from([1, 30]));
      expect(await fakeServer.readExactly(1)).toEqual(Buffer.from([30]));
      const header = Buffer.alloc(4);
      header.writeUInt16BE(5, 0);
      header.writeUInt16BE(keyLength, 2);
      await fakeServer.write(header);
      await expect(preauth).rejects.toThrow(`invalid ARD key length ${keyLength}`);
    } finally {
      gatewayServer.destroy();
      fakeServerStream.destroy();
      gatewayBrowserStream.destroy();
      fakeBrowserStream.destroy();
    }
  });

  it("rejects zero ARD Diffie-Hellman parameters", async () => {
    const [gatewayServer, fakeServerStream] = duplexPair();
    const [gatewayBrowserStream, fakeBrowserStream] = duplexPair();
    const fakeServer = new ScriptedPeer(fakeServerStream);
    const preauth = preauthenticateRfb({
      server: gatewayServer,
      browser: new ScriptedPeer(gatewayBrowserStream),
      preauth: {
        auth: "ard-account",
        credentials: { username: "operator", password: "password" },
      },
    });
    try {
      await fakeServer.write(VERSION_3_8);
      expect(await fakeServer.readExactly(12)).toEqual(VERSION_3_8);
      await fakeServer.write(Buffer.from([1, 30]));
      expect(await fakeServer.readExactly(1)).toEqual(Buffer.from([30]));
      const header = Buffer.alloc(4);
      header.writeUInt16BE(5, 0);
      header.writeUInt16BE(8, 2);
      await fakeServer.write(Buffer.concat([header, Buffer.alloc(16)]));
      await expect(preauth).rejects.toThrow("invalid ARD Diffie-Hellman parameters");
    } finally {
      gatewayServer.destroy();
      fakeServerStream.destroy();
      gatewayBrowserStream.destroy();
      fakeBrowserStream.destroy();
    }
  });

  it("surfaces the ARD server SecurityResult reason", async () => {
    const reason = Buffer.from("account rejected", "utf8");
    const [gatewayServer, fakeServerStream] = duplexPair();
    const [gatewayBrowserStream, fakeBrowserStream] = duplexPair();
    const fakeServer = new ScriptedPeer(fakeServerStream);
    const preauth = preauthenticateRfb({
      server: gatewayServer,
      browser: new ScriptedPeer(gatewayBrowserStream),
      preauth: {
        auth: "ard-account",
        credentials: { username: "operator", password: "password" },
      },
    });
    try {
      await writeArdOffer(fakeServer, 16);
      await fakeServer.readExactly(144);
      const status = Buffer.alloc(8);
      status.writeUInt32BE(1, 0);
      status.writeUInt32BE(reason.length, 4);
      await fakeServer.write(Buffer.concat([status, reason]));
      await expect(preauth).rejects.toThrow("RFB authentication failed: account rejected");
    } finally {
      gatewayServer.destroy();
      fakeServerStream.destroy();
      gatewayBrowserStream.destroy();
      fakeBrowserStream.destroy();
    }
  });

  it.each([
    ["RFB 003.003\n", "RFB 003.003\n", true],
    ["RFB 003.007\n", "RFB 003.007\n", false],
    ["RFB 003.008\n", "RFB 003.008\n", false],
    ["RFB 003.889\n", "RFB 003.008\n", false],
  ])("matches the VncAuth DES vector with server version %j", async (banner, reply, legacy) => {
    const challenge = Buffer.from("0123456789abcdef", "ascii");
    await runPreauth({
      preauth: { auth: "vnc-password", credentials: { password: "password" } },
      serverScript: async (server) => {
        await server.write(Buffer.from(banner));
        expect(await server.readExactly(12)).toEqual(Buffer.from(reply));
        await server.write(legacy ? Buffer.from([0, 0, 0, 2]) : Buffer.from([1, 2]));
        if (!legacy) {
          expect(await server.readExactly(1)).toEqual(Buffer.from([2]));
        }
        await server.write(challenge);
        expect((await server.readExactly(16)).toString("hex")).toBe(
          "5645abeb5f1e6475e8feb11beb66ea19",
        );
        await server.write(Buffer.alloc(4));
      },
    });
  });
});
