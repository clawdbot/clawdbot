import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterAll, describe, expect, it, vi } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { parseBrowserNativeHostOrigins, runBrowserNativeHost } from "./extension-native-host.js";
import {
  decodeBrowserNativeFrame,
  encodeBrowserNativeResponse,
  readBrowserNativeFrame,
} from "./extension-native-protocol.js";
import { ensureExtensionRelayDaemonProcess } from "./extension-relay-daemon-spawn.js";
import { runExtensionRelayDaemon } from "./relay-daemon.js";
import { getFreePort } from "./test-port.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const STORE_ORIGIN = "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/";
const OTHER_ORIGIN = `chrome-extension://${"p".repeat(32)}/`;
const NONCE = Buffer.alloc(16, 7).toString("base64url");
const PAIRING = `ws://127.0.0.1:18799/extension#${relayTestKey(1)}`;
const REQUEST_MAX_BYTES = 4 * 1024;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let defaultFixture: ReturnType<typeof nativeFixture> | undefined;

function frame(payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const result = Buffer.alloc(body.length + 4);
  if (os.endianness() === "LE") {
    result.writeUInt32LE(body.length);
  } else {
    result.writeUInt32BE(body.length);
  }
  body.copy(result, 4);
  return result;
}

function requestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, op: "bootstrap", nonce: NONCE, ...overrides });
}

async function* chunks(...values: Buffer[]) {
  for (const value of values) {
    yield value;
  }
}

describe("native messaging framing", () => {
  it("reads a fragmented native-endian frame exactly", async () => {
    const expected = frame(requestJson());
    const actual = await readBrowserNativeFrame(
      chunks(
        expected.subarray(0, 1),
        expected.subarray(1, 4),
        expected.subarray(4, 9),
        expected.subarray(9),
      ),
    );

    expect(actual).toEqual(expected);
    expect(decodeBrowserNativeFrame(actual)).toEqual({
      ok: true,
      request: { v: 1, op: "bootstrap", nonce: NONCE },
    });
  });

  it.each([
    ["truncated header", Buffer.from([1, 0, 0])],
    ["truncated body", frame(requestJson()).subarray(0, 8)],
    ["zero length", Buffer.alloc(4)],
    ["multiple messages", Buffer.concat([frame(requestJson()), frame(requestJson())])],
  ])("rejects %s", async (_label, input) => {
    await expect(readBrowserNativeFrame(chunks(input))).rejects.toThrow("invalid_frame");
  });

  it("returns a complete request without waiting for Chrome to close stdin", async () => {
    const expected = frame(requestJson());
    let first = true;
    const openPipe = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (first) {
              first = false;
              return { done: false as const, value: expected };
            }
            return await new Promise<IteratorResult<Buffer>>(() => {});
          },
        };
      },
    };
    const result = await withTimeout(
      readBrowserNativeFrame(openPipe),
      100,
      "native frame without closing stdin",
    );

    expect(result).toEqual(expected);
  });

  it("rejects an oversized length before allocating its payload", async () => {
    const header = Buffer.alloc(4);
    if (os.endianness() === "LE") {
      header.writeUInt32LE(REQUEST_MAX_BYTES + 1);
    } else {
      header.writeUInt32BE(REQUEST_MAX_BYTES + 1);
    }

    await expect(readBrowserNativeFrame(chunks(header))).rejects.toThrow("invalid_frame");
  });

  it("rejects fatal UTF-8", () => {
    expect(decodeBrowserNativeFrame(frame(Buffer.from([0xc3, 0x28])))).toEqual({
      ok: false,
      code: "invalid_utf8",
    });
  });

  it("uses one bounded stdout frame", () => {
    const output = encodeBrowserNativeResponse({
      v: 1,
      ok: true,
      nonce: NONCE,
      pairingString: PAIRING,
    });
    const length = os.endianness() === "LE" ? output.readUInt32LE() : output.readUInt32BE();
    expect(output).toHaveLength(length + 4);
    expect(length).toBeLessThan(1024 * 1024);
    expect(JSON.parse(output.subarray(4).toString("utf8"))).toEqual({
      v: 1,
      ok: true,
      nonce: NONCE,
      pairingString: PAIRING,
    });
  });
});

describe("native bootstrap request schema", () => {
  it("accepts only the exact flat request", () => {
    expect(decodeBrowserNativeFrame(frame(requestJson()))).toEqual({
      ok: true,
      request: { v: 1, op: "bootstrap", nonce: NONCE },
    });
  });

  it.each([
    ["array", JSON.stringify([{ v: 1, op: "bootstrap", nonce: NONCE }])],
    ["prototype-shaped", `{"v":1,"op":"bootstrap","nonce":"${NONCE}","__proto__":{}}`],
    [
      "constructor field",
      JSON.stringify({ v: 1, op: "bootstrap", nonce: NONCE, constructor: "x" }),
    ],
    ["duplicate field", `{"v":1,"op":"bootstrap","nonce":"${NONCE}","nonce":"${NONCE}"}`],
    ["unknown field", JSON.stringify({ v: 1, op: "bootstrap", nonce: NONCE, extra: true })],
    ["padded nonce", JSON.stringify({ v: 1, op: "bootstrap", nonce: `${NONCE}=` })],
    ["short nonce", JSON.stringify({ v: 1, op: "bootstrap", nonce: "AA" })],
  ])("rejects $0", (_label, raw) => {
    expect(decodeBrowserNativeFrame(frame(raw))).toEqual({
      ok: false,
      code: "invalid_request",
    });
  });
});

async function nativeFixture() {
  const root = tempDirs.make("openclaw-native-host-");
  const stateDir = path.join(root, "state");
  const managedDir = path.join(stateDir, "browser", "native-messaging");
  const manifestDir = path.join(root, "chrome", "NativeMessagingHosts");
  await fs.mkdir(managedDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(manifestDir, { recursive: true, mode: 0o700 });
  const launcherPath = path.join(managedDir, "bootstrap.sh");
  const manifestPath = path.join(manifestDir, "ai.openclaw.browser_bootstrap.json");
  await fs.writeFile(launcherPath, "#!/bin/sh\n", { mode: 0o700 });
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      name: "ai.openclaw.browser_bootstrap",
      description: "OpenClaw browser extension bootstrap",
      path: launcherPath,
      type: "stdio",
      allowed_origins: [ORIGIN],
    })}\n`,
    { mode: 0o600 },
  );
  return { stateDir, launcherPath, manifestPath };
}

async function invokeHost(overrides: Partial<Parameters<typeof runBrowserNativeHost>[0]> = {}) {
  // Callers that mutate manifests or credentials supply their own private fixture.
  const fixture = await (defaultFixture ??= nativeFixture());
  const writes: Buffer[] = [];
  const response = await runBrowserNativeHost({
    ...fixture,
    callerOrigin: ORIGIN,
    expectedOrigins: [ORIGIN],
    input: chunks(frame(requestJson())),
    write: (value) => writes.push(value),
    buildPairing: async () => ({ pairingString: PAIRING, topology: "local" }),
    ensureRelay: async () => "skipped",
    ...overrides,
  });
  return { response, writes, fixture };
}

describe("native host origin and topology boundary", () => {
  it("parses a nonempty sorted unique expected-origin list before the caller origin", () => {
    expect(
      parseBrowserNativeHostOrigins([
        "--manifest",
        "manifest.json",
        "--expected-origin",
        ORIGIN,
        "--expected-origin",
        OTHER_ORIGIN,
        OTHER_ORIGIN,
      ]),
    ).toEqual({ expectedOrigins: [ORIGIN, OTHER_ORIGIN], callerOrigin: OTHER_ORIGIN });
  });

  it.each([
    ["missing list", [ORIGIN]],
    ["missing value", ["--expected-origin"]],
    ["duplicate", ["--expected-origin", ORIGIN, "--expected-origin", ORIGIN, ORIGIN]],
    ["unsorted", ["--expected-origin", OTHER_ORIGIN, "--expected-origin", ORIGIN, ORIGIN]],
    ["malformed", ["--expected-origin", "chrome-extension://*/", ORIGIN]],
    ["multiple callers", ["--expected-origin", ORIGIN, ORIGIN, OTHER_ORIGIN]],
  ])("rejects %s expected-origin arguments", (_label, argv) => {
    expect(() => parseBrowserNativeHostOrigins(argv)).toThrow();
  });

  it("echoes the nonce and returns only the canonical pairing", async () => {
    const result = await invokeHost();
    expect(result.response).toEqual({ v: 1, ok: true, nonce: NONCE, pairingString: PAIRING });
    expect(result.writes).toHaveLength(1);
  });

  it("accepts the exact Store caller when launcher args and manifest match", async () => {
    const fixture = await nativeFixture();
    const expectedOrigins = [ORIGIN, STORE_ORIGIN].toSorted();
    await fs.writeFile(
      fixture.manifestPath,
      `${JSON.stringify({
        name: "ai.openclaw.browser_bootstrap",
        description: "OpenClaw browser extension bootstrap",
        path: fixture.launcherPath,
        type: "stdio",
        allowed_origins: expectedOrigins,
      })}\n`,
      { mode: 0o600 },
    );

    const result = await invokeHost({
      ...fixture,
      callerOrigin: STORE_ORIGIN,
      expectedOrigins,
    });

    expect(result.response).toEqual({
      v: 1,
      ok: true,
      nonce: NONCE,
      pairingString: PAIRING,
    });
  });

  it("rejects a wrong extension origin", async () => {
    const result = await invokeHost({ callerOrigin: OTHER_ORIGIN });
    expect(result.response).toEqual({ v: 1, ok: false, code: "origin_forbidden" });
  });

  it("rejects a manifest with an extra valid origin before building pairing", async () => {
    const fixture = await nativeFixture();
    await fs.writeFile(
      fixture.manifestPath,
      `${JSON.stringify({
        name: "ai.openclaw.browser_bootstrap",
        description: "OpenClaw browser extension bootstrap",
        path: fixture.launcherPath,
        type: "stdio",
        allowed_origins: [ORIGIN, OTHER_ORIGIN],
      })}\n`,
      { mode: 0o600 },
    );
    const buildPairing = vi.fn(async () => ({ pairingString: PAIRING, topology: "local" }));

    const response = await runBrowserNativeHost({
      ...fixture,
      callerOrigin: ORIGIN,
      expectedOrigins: [ORIGIN],
      input: chunks(frame(requestJson())),
      write: vi.fn(),
      buildPairing,
      ensureRelay: async () => "skipped",
    });

    expect(response).toEqual({ v: 1, ok: false, code: "manifest_invalid" });
    expect(buildPairing).not.toHaveBeenCalled();
  });

  it("rejects a wildcard manifest", async () => {
    const fixture = await nativeFixture();
    await fs.writeFile(
      fixture.manifestPath,
      JSON.stringify({
        name: "ai.openclaw.browser_bootstrap",
        description: "OpenClaw browser extension bootstrap",
        path: fixture.launcherPath,
        type: "stdio",
        allowed_origins: ["chrome-extension://*/"],
      }),
      { mode: 0o600 },
    );
    const writes: Buffer[] = [];
    const response = await runBrowserNativeHost({
      ...fixture,
      callerOrigin: ORIGIN,
      expectedOrigins: [ORIGIN],
      input: chunks(frame(requestJson())),
      write: (value) => writes.push(value),
      buildPairing: async () => ({ pairingString: PAIRING, topology: "local" }),
      ensureRelay: async () => "skipped",
    });
    expect(response).toEqual({ v: 1, ok: false, code: "manifest_invalid" });
  });

  it("returns manual_required for direct remote topology and Windows", async () => {
    await expect(
      invokeHost({
        buildPairing: async () => ({ pairingString: PAIRING, topology: "direct-remote" }),
      }).then((result) => result.response),
    ).resolves.toEqual({ v: 1, ok: false, code: "manual_required" });
    await expect(
      invokeHost({ platform: "win32" }).then((result) => result.response),
    ).resolves.toEqual({
      v: 1,
      ok: false,
      code: "manual_required",
    });
  });
});

describe("native host ensure_relay", () => {
  it.each([
    ["missing port", requestJson({ op: "ensure_relay" })],
    ...[0, -1, 65536, 18799.5, "18799", null, {}, [18799]].map((relayPort) => [
      `invalid port ${JSON.stringify(relayPort)}`,
      requestJson({ op: "ensure_relay", relayPort }),
    ]),
    [
      "duplicate port",
      `{"v":1,"op":"ensure_relay","nonce":"${NONCE}","relayPort":18799,"relayPort":18798}`,
    ],
    [
      "escaped duplicate port",
      `{"v":1,"op":"ensure_relay","nonce":"${NONCE}","relayPort":18799,"relay\\u0050ort":18798}`,
    ],
    ...["host", "entryPath", "token", "profile"].map((key) => [
      key,
      requestJson({ op: "ensure_relay", relayPort: 18799, [key]: "untrusted" }),
    ]),
    ["bootstrap with target", requestJson({ relayPort: 18799 })],
  ])("rejects %s without invoking the relay launcher", async (_label, raw) => {
    const ensureRelay = vi.fn(async () => "spawned" as const);
    const result = await invokeHost({ input: chunks(frame(raw)), ensureRelay });
    expect(result.response).toEqual({ v: 1, ok: false, code: "invalid_request" });
    expect(ensureRelay).not.toHaveBeenCalled();
  });

  it.each([
    ["unconfigured", 20124],
    ["managed browser", 18800],
    ["Gateway", 18789],
    ["remote browser", 29443],
  ])("rejects the %s port before probing or spawning", async (_label, relayPort) => {
    const probe = vi.fn(async () => false);
    const spawnProcess = vi.fn();
    const result = await invokeHost({
      input: chunks(frame(requestJson({ op: "ensure_relay", relayPort }))),
      ensureRelay: async (port) =>
        await ensureExtensionRelayDaemonProcess({
          port,
          cfg: { browser: { profiles: { remote: { cdpUrl: "https://browser.example:29443" } } } },
          entryPath: "/opt/openclaw/dist/extensions/browser/relay-daemon-entry.js",
          probe,
          spawnProcess,
        }),
    });
    expect(result.response).toEqual({ v: 1, ok: false, code: "relay_unavailable" });
    expect(probe).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each(["non-first automatic", "explicitly pinned"])(
    "wakes the %s profile through the native frame and config boundary",
    async (allocation) => {
      const fixture = await nativeFixture();
      const relayPort = await getFreePort();
      await fs.mkdir(path.join(fixture.stateDir, "credentials"), { mode: 0o700 });
      await fs.writeFile(
        path.join(fixture.stateDir, "credentials", "browser-extension-relay.secret"),
        relayTestKey(1),
        { mode: 0o600 },
      );
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: fixture.stateDir, OPENCLAW_GATEWAY_PORT: undefined },
        async () => {
          let daemon: ReturnType<typeof runExtensionRelayDaemon> | undefined;
          try {
            const result = await invokeHost({
              ...fixture,
              input: chunks(frame(requestJson({ op: "ensure_relay", relayPort }))),
              ensureRelay: async (port) =>
                await ensureExtensionRelayDaemonProcess({
                  port,
                  cfg: {
                    gateway: { port: relayPort - 9 },
                    browser: {
                      profiles: {
                        chrome: { driver: "extension" },
                        work: {
                          driver: "extension",
                          ...(allocation === "explicitly pinned" ? { cdpPort: relayPort } : {}),
                        },
                      },
                    },
                  },
                  entryPath: "/opt/openclaw/dist/extensions/browser/relay-daemon-entry.js",
                  // Keep the real config, port probe, credential read and relay server;
                  // only replace process creation so the test owns daemon cleanup.
                  spawnProcess: (_command, args) => {
                    daemon = runExtensionRelayDaemon({ port: Number(args[2]) });
                  },
                }),
            });
            expect(result.response).toEqual({ v: 1, ok: true, nonce: NONCE, relay: "spawned" });
            const run = await daemon;
            expect(run?.port).toBe(relayPort);
            const response = await fetch(`http://127.0.0.1:${relayPort}/json/version`);
            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ error: "Unauthorized" });
          } finally {
            const run = await daemon;
            run?.stop();
            await run?.done;
          }
        },
      );
    },
  );

  it("reports the injected relay status with the echoed nonce", async () => {
    const ensureRelay = vi.fn(async () => "spawned" as const);
    const result = await invokeHost({
      input: chunks(frame(requestJson({ op: "ensure_relay", relayPort: 18799 }))),
      ensureRelay,
    });
    expect(result.response).toEqual({ v: 1, ok: true, nonce: NONCE, relay: "spawned" });
    expect(ensureRelay).toHaveBeenCalledTimes(1);
    expect(result.writes).toHaveLength(1);
  });

  it("maps a relay launcher failure to relay_unavailable", async () => {
    const result = await invokeHost({
      input: chunks(frame(requestJson({ op: "ensure_relay", relayPort: 18799 }))),
      ensureRelay: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(result.response).toEqual({ v: 1, ok: false, code: "relay_unavailable" });
  });

  it("still validates the manifest before ensuring the relay", async () => {
    const ensureRelay = vi.fn(async () => "spawned" as const);
    const result = await invokeHost({
      input: chunks(frame(requestJson({ op: "ensure_relay", relayPort: 18799 }))),
      callerOrigin: OTHER_ORIGIN,
      ensureRelay,
    });
    expect(result.response).toEqual({ v: 1, ok: false, code: "origin_forbidden" });
    expect(ensureRelay).not.toHaveBeenCalled();
  });
});
