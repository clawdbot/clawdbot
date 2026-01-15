import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";

async function getFreePort(): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const assigned = (s.address() as AddressInfo).port;
        s.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port < 65535) return port;
  }
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function createMessageQueue(ws: WebSocket) {
  const queue: string[] = [];
  let waiter: ((value: string) => void) | null = null;
  let waiterReject: ((err: Error) => void) | null = null;
  let waiterTimer: NodeJS.Timeout | null = null;

  const flushWaiter = (value: string) => {
    if (!waiter) return false;
    const resolve = waiter;
    waiter = null;
    const reject = waiterReject;
    waiterReject = null;
    if (waiterTimer) clearTimeout(waiterTimer);
    waiterTimer = null;
    if (reject) {
      // no-op (kept for symmetry)
    }
    resolve(value);
    return true;
  };

  ws.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
    if (flushWaiter(text)) return;
    queue.push(text);
  });

  ws.on("error", (err) => {
    if (!waiterReject) return;
    const reject = waiterReject;
    waiterReject = null;
    waiter = null;
    if (waiterTimer) clearTimeout(waiterTimer);
    waiterTimer = null;
    reject(err instanceof Error ? err : new Error(String(err)));
  });

  const next = (timeoutMs = 5000) =>
    new Promise<string>((resolve, reject) => {
      const existing = queue.shift();
      if (existing !== undefined) return resolve(existing);
      waiter = resolve;
      waiterReject = reject;
      waiterTimer = setTimeout(() => {
        waiter = null;
        waiterReject = null;
        waiterTimer = null;
        reject(new Error("timeout"));
      }, timeoutMs);
    });

  return { next };
}

describe("chrome extension relay server", () => {
  let cdpUrl = "";

  afterEach(async () => {
    if (cdpUrl) {
      await stopChromeExtensionRelayServer({ cdpUrl }).catch(() => {});
      cdpUrl = "";
    }
  });

  it("advertises CDP WS only when extension is connected", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const v1 = (await fetch(`${cdpUrl}/json/version`).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(v1.webSocketDebuggerUrl).toBeUndefined();

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    const v2 = (await fetch(`${cdpUrl}/json/version`).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(String(v2.webSocketDebuggerUrl ?? "")).toContain(`/cdp`);

    ext.close();
  });

  it("tracks attached page targets and exposes them via CDP + /json/list", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    // Simulate a tab attach coming from the extension.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "Example",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const list = (await fetch(`${cdpUrl}/json/list`).then((r) => r.json())) as Array<{
      id?: string;
      url?: string;
    }>;
    expect(list.some((t) => t.id === "t1" && t.url === "https://example.com")).toBe(true);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    const res1 = JSON.parse(await q.next()) as { id: number; result?: unknown };
    expect(res1.id).toBe(1);
    expect(JSON.stringify(res1.result ?? {})).toContain("t1");

    cdp.send(
      JSON.stringify({
        id: 2,
        method: "Target.attachToTarget",
        params: { targetId: "t1" },
      }),
    );
    const received: Array<{
      id?: number;
      method?: string;
      result?: unknown;
      params?: unknown;
    }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const res2 = received.find((m) => m.id === 2);
    expect(res2?.id).toBe(2);
    expect(JSON.stringify(res2?.result ?? {})).toContain("cb-tab-1");

    const evt = received.find((m) => m.method === "Target.attachedToTarget");
    expect(evt?.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(evt?.params ?? {})).toContain("t1");

    cdp.close();
    ext.close();
  }, 15_000);
});
