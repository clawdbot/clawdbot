import { createConnection } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { httpServers } from "./monitor.state.js";
import { monitorWebhook } from "./monitor.transport.js";
import {
  createFeishuWebhookTestAccount,
  getFreePort,
  signFeishuPayload,
  waitUntilServerReady,
} from "./monitor.webhook.test-helpers.js";

afterEach(() => {
  cleanupFeishuMonitorStateForTests();
});

describe("Feishu webhook activity", () => {
  it("does not publish healthy activity when the client aborts a held signed dispatch", async () => {
    const accountId = "aborted-signed-dispatch";
    const path = "/hook-e2e-aborted-signed-dispatch";
    const port = await getFreePort();
    let releaseDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let markDispatchStarted: () => void = () => {};
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const handler = vi.fn(async () => {
      markDispatchStarted();
      await dispatchGate;
      return { accepted: true };
    });
    const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
    eventDispatcher.register({ "test.aborted_dispatch": handler });
    const statusSink = vi.fn();
    const abortController = new AbortController();
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, port, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher,
      statusSink,
    });
    const socket = createConnection({ host: "127.0.0.1", port });
    try {
      await waitUntilServerReady(`http://127.0.0.1:${port}${path}`);
      statusSink.mockClear();
      const server = expectDefined(httpServers.get(accountId), "webhook server");
      const responseClosed = new Promise<void>((resolve) => {
        server.once("request", (_req, res) => res.once("close", resolve));
      });
      const rawBody = JSON.stringify({
        schema: "2.0",
        header: { event_type: "test.aborted_dispatch" },
        event: {},
      });
      const headers = Object.entries(signFeishuPayload({ encryptKey: "encrypt_key", rawBody }))
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\nContent-Length: ${Buffer.byteLength(rawBody)}\r\n\r\n${rawBody}`,
      );
      await dispatchStarted;
      const clientClosed = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      socket.destroy();
      await clientClosed;
      await responseClosed;
      expect(statusSink).not.toHaveBeenCalled();
      releaseDispatch();
      await expect(handler.mock.results[0]?.value).resolves.toEqual({ accepted: true });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(statusSink).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      releaseDispatch();
      abortController.abort();
      await monitorPromise;
    }
  });
});
