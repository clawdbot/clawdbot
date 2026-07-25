import { afterEach, describe, expect, it } from "vitest";
import type { RelayToExtensionMessage } from "./relay-protocol.js";
import { type ExtensionRelayHandle, startExtensionRelayServer } from "./relay-server.js";

const TOKEN = "a".repeat(64);
const handles: ExtensionRelayHandle[] = [];

function sendHello(handlers: { onMessage: (raw: string) => void }, advertiseProbe = true): void {
  handlers.onMessage(
    JSON.stringify({
      type: "hello",
      userAgent: "Mozilla/5.0 Chrome/144.0.0.0",
      browserVersion: "Chrome/144.0.0.0",
      extensionVersion: "2.0.0",
      tabs: [],
      ...(advertiseProbe ? { capabilities: ["probe-v1"] } : {}),
    }),
  );
}

async function startRelay(
  probeResponseDelayMs: number | null,
  advertiseProbe = true,
): Promise<ExtensionRelayHandle> {
  const handle = await startExtensionRelayServer({ port: 0, token: TOKEN });
  handles.push(handle);
  const socket: { send: (raw: string) => void; close: () => void } = {
    send: () => {},
    close: () => {},
  };
  const handlers = handle.bridge.attachExtensionSocket(socket);
  socket.send = (raw) => {
    const message = JSON.parse(raw) as RelayToExtensionMessage;
    if (message.type === "probe" && probeResponseDelayMs !== null) {
      setTimeout(() => {
        handlers.onMessage(
          JSON.stringify({
            type: "result",
            seq: message.seq,
            result: { sharedTabCount: 0 },
          }),
        );
      }, probeResponseDelayMs);
    }
  };
  sendHello(handlers, advertiseProbe);
  return handle;
}

async function fetchVersion(handle: ExtensionRelayHandle): Promise<Response> {
  const authorization = Buffer.from(`openclaw:${TOKEN}`).toString("base64");
  return await fetch(`http://127.0.0.1:${handle.port}/json/version`, {
    headers: { Authorization: `Basic ${authorization}` },
  });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => await handle.close()));
});

describe("extension relay health", () => {
  it("reports a responsive extension with zero shared tabs as available", async () => {
    const response = await fetchVersion(await startRelay(300));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      Browser: "Chrome/144.0.0.0",
    });
  });

  it("reports a hello-but-unresponsive extension as unavailable", async () => {
    const response = await fetchVersion(await startRelay(null));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("not responding"),
    });
  });

  it("keeps a pre-probe extension available through its legacy hello handshake", async () => {
    const response = await fetchVersion(await startRelay(null, false));

    expect(response.status).toBe(200);
  });
});
