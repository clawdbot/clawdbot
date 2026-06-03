/**
 * Regression test for issue #88230.
 *
 * The CLI path `openclaw message send` tears the gateway client down after
 * delivery and relies on a natural process exit. If the WebSocket's underlying
 * `_socket` file descriptor stays ref'd in the Node event loop, the process
 * hangs indefinitely even though the close handshake has been initiated.
 *
 * Two teardown contracts share `beginStop()` and must both end with the socket
 * unref'd, but with different *timing*:
 *
 *  - `stop()` is fire-and-forget (the CLI `message send` path). Nobody awaits
 *    it, so it must unref the socket immediately after the transport close
 *    (via `protocol.stop()`).
 *  - `stopAndWait()` is awaited (e.g. `openclaw message send --json`, which
 *    writes its JSON result only after teardown settles). It must keep the
 *    socket ref'd until its promise settles, then unref — otherwise unrefing
 *    the last handle up-front lets the process exit mid-await, before the
 *    result is written (ClawSweeper review P1, confidence 0.86).
 *
 * These tests pin both behaviors against the current packaging where teardown
 * closes through the protocol transport adapter rather than a bare `ws.close()`.
 */

import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GatewayClient } from "./client.js";

type FakeSocket = { unref: () => void };

// The terminate-grace fallback (FORCE_STOP_TERMINATE_GRACE_MS) is 250ms; a fake
// ws emits no real close event, so awaited teardown settles via that fallback.
// Keep stopAndWait timeouts comfortably above it so the race doesn't time out.
const SETTLE_TIMEOUT_MS = 1000;

function attachFakeWs(
  client: GatewayClient,
  { unref }: { unref?: () => void },
): void {
  const ws: Record<string, unknown> = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    // beginStop()'s fallback calls ws.terminate() after the grace period to
    // resolve the pending stop when no real close handshake arrives.
    terminate: vi.fn(),
  };
  if (unref) {
    (ws as { _socket: FakeSocket })["_socket"] = { unref };
  }
  (client as unknown as { ws: unknown }).ws = ws;
  // Main routes socket close through protocol.stop() -> transport adapter.
  // Provide a minimal protocol that will not throw during teardown.
  (client as unknown as { protocol: { connecting: boolean; stop: () => void } }).protocol = {
    connecting: false,
    stop: vi.fn(),
  };
}

describe("GatewayClient socket unref (issue #88230)", () => {
  test("stop() unrefs the underlying socket immediately (fire-and-forget)", () => {
    const client = new GatewayClient({ requestTimeoutMs: 1000 });
    const unref = vi.fn();
    attachFakeWs(client, { unref });

    expect(unref).not.toHaveBeenCalled();

    client.stop();

    // Fire-and-forget: protocol/stop path THEN unref, synchronously.
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("stop() tolerates a ws without an internal _socket (defensive contract)", () => {
    // `_socket` is an internal property of the `ws` package with no public
    // contract; the production code wraps the unref in try/catch. Verify
    // stop() does not throw when _socket is absent.
    const client = new GatewayClient({ requestTimeoutMs: 1000 });
    attachFakeWs(client, {});

    expect(() => client.stop()).not.toThrow();
  });

  test("stopAndWait() does NOT unref until its promise settles", async () => {
    // The core #88230 review fix: unrefing the socket up-front inside the
    // shared beginStop() would drop the last ref'd handle before the awaited
    // teardown settles, letting `openclaw message send --json` exit before its
    // JSON result is written. The unref must happen only after settlement.
    const client = new GatewayClient({ requestTimeoutMs: 1000 });
    const unref = vi.fn();
    attachFakeWs(client, { unref });

    const waitPromise = client.stopAndWait({ timeoutMs: SETTLE_TIMEOUT_MS });

    // Synchronously after the call, beginStop has run but the socket is still
    // ref'd — the awaited result must be allowed to settle first.
    expect(unref).not.toHaveBeenCalled();

    await waitPromise;

    // Once teardown settles (here via the terminate/timeout fallback), the
    // socket is released so a natural exit isn't blocked by the open FD.
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("stopAndWait() tolerates a ws without an internal _socket", async () => {
    const client = new GatewayClient({ requestTimeoutMs: 1000 });
    attachFakeWs(client, {});

    await expect(client.stopAndWait({ timeoutMs: SETTLE_TIMEOUT_MS })).resolves.toBeUndefined();
  });
});
