import type { AddressInfo } from "node:net";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildRelayWebSocketOptions,
  buildRelayWebSocketUrl,
  monitorSlackRelaySource,
  parseRelayFrame,
  SlackRelayMalformedFrameError,
  SLACK_RELAY_MAX_PAYLOAD_BYTES,
  type SlackRelayIdentity,
} from "./relay-source.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function relayFrame(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

describe("Slack relay source", () => {
  it("builds authenticated relay websocket URLs safely", () => {
    expect(
      buildRelayWebSocketUrl({
        url: "https://router.example.com/gateway/ws?existing=1",
        authToken: "secret",
        gatewayId: "pash",
      }),
    ).toBe("wss://router.example.com/gateway/ws?existing=1&gateway_id=pash");

    expect(() =>
      buildRelayWebSocketUrl({
        url: "ws://router.example.com/gateway/ws",
        authToken: "secret",
        gatewayId: "pash",
      }),
    ).toThrow("plaintext ws:// for non-local host");
    expect(() =>
      buildRelayWebSocketUrl({
        url: "https://router.example.com",
        authToken: "secret",
        gatewayId: "pash",
      }),
    ).toThrow("must include its websocket path");

    expect(buildRelayWebSocketOptions("secret")).toMatchObject({
      headers: { Authorization: "Bearer secret" },
      maxPayload: SLACK_RELAY_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
  });

  it("applies hello identity and acks a routed event only after durable accept", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const ack = deferred<Record<string, unknown>>();
    const acceptStarted = deferred<void>();
    const acceptDone = deferred<void>();
    const receivedAcks: Array<Record<string, unknown>> = [];
    const requestHeaders = deferred<{ authorization?: string; url?: string }>();
    server.once("connection", (socket, request) => {
      requestHeaders.resolve({
        authorization: request.headers.authorization,
        url: request.url,
      });
      socket.on("message", (data) => {
        const messageText = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data)).toString("utf8")
            : Buffer.from(data).toString("utf8");
        const frame = JSON.parse(messageText) as Record<string, unknown>;
        receivedAcks.push(frame);
        ack.resolve(frame);
      });
      socket.send(
        JSON.stringify({
          type: "hello",
          gateway_id: "pash",
          slack_identity: {
            username: "Nik Team Claw",
            icon_url: "https://example.com/nik.png",
          },
        }),
      );
      socket.send("not-json");
      socket.send(
        JSON.stringify({
          type: "slack_event",
          delivery_id: "delivery-failed",
          route: { kind: "user_group", key: "T1:S1" },
          payload: {
            event: {
              type: "message",
              channel: "C1",
              user: "U1",
              text: "fail-handler",
              ts: "1.000000",
            },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "slack_event",
          delivery_id: "delivery-1",
          route: { kind: "channel_default", key: "T1:C1" },
          payload: {
            team_id: "T1",
            event_id: "Ev1",
            event: {
              type: "message",
              channel: "C1",
              user: "U1",
              text: "hello",
              ts: "1.000001",
            },
          },
        }),
      );
    });

    const abortController = new AbortController();
    const acceptRelayEvent = vi.fn(
      async (event: { deliveryId: string; message: { text?: string } }) => {
        if (event.message.text === "fail-handler") {
          throw new Error("durable accept failed");
        }
        acceptStarted.resolve();
        await acceptDone.promise;
      },
    );
    const runtimeError = vi.fn();
    const identities: Array<SlackRelayIdentity | undefined> = [];
    const statuses: Array<Record<string, unknown>> = [];
    const monitor = monitorSlackRelaySource({
      config: {
        url: `ws://127.0.0.1:${port}/gateway/ws`,
        authToken: "relay-secret",
        gatewayId: "pash",
      },
      acceptRelayEvent,
      runtime: { error: runtimeError, log: vi.fn() } as unknown as RuntimeEnv,
      abortSignal: abortController.signal,
      setIdentity: (identity) => identities.push(identity),
      setStatus: (status) => statuses.push(status),
    });

    await expect(requestHeaders.promise).resolves.toEqual({
      authorization: "Bearer relay-secret",
      url: "/gateway/ws?gateway_id=pash",
    });
    await acceptStarted.promise;
    expect(receivedAcks).toEqual([]);
    acceptDone.resolve();
    await expect(ack.promise).resolves.toEqual({
      type: "ack",
      delivery_id: "delivery-1",
    });
    expect(receivedAcks).toEqual([{ type: "ack", delivery_id: "delivery-1" }]);
    expect(runtimeError).toHaveBeenCalledTimes(2);
    expect(acceptRelayEvent).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      message: expect.objectContaining({ channel: "C1", text: "hello" }),
    });
    // The failed durable accept must never ack: the router redelivers it.
    expect(receivedAcks).not.toContainEqual({ type: "ack", delivery_id: "delivery-failed" });
    expect(identities).toContainEqual({
      username: "Nik Team Claw",
      iconUrl: "https://example.com/nik.png",
    });
    expect(statuses).toContainEqual({
      relayRoute: { kind: "channel_default", key: "T1:C1" },
    });

    abortController.abort();
    await monitor;
    expect(identities.at(-1)).toBeUndefined();
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  describe("parseRelayFrame", () => {
    it("parses valid JSON frames", () => {
      const frame = parseRelayFrame(
        relayFrame(JSON.stringify({ type: "slack_event", data: { text: "hello" } })),
      );
      expect(frame).toEqual({ type: "slack_event", data: { text: "hello" } });
    });

    it("throws SlackRelayMalformedFrameError for malformed JSON", () => {
      expect(() => parseRelayFrame(relayFrame("NOT JSON {{{"))).toThrow(
        SlackRelayMalformedFrameError,
      );
    });

    it("wraps the original SyntaxError as the cause", () => {
      let error: unknown;
      try {
        parseRelayFrame(relayFrame("NOT JSON {{{"));
      } catch (err: unknown) {
        error = err;
      }
      expect(error).toBeInstanceOf(SlackRelayMalformedFrameError);
      expect((error as SlackRelayMalformedFrameError).message).toContain("malformed JSON frame");
      expect((error as SlackRelayMalformedFrameError).cause).toBeDefined();
    });

    it("parses empty object frames", () => {
      expect(parseRelayFrame(relayFrame("{}"))).toEqual({});
    });

    it("parses array frames", () => {
      expect(parseRelayFrame(relayFrame("[1, 2, 3]"))).toEqual([1, 2, 3]);
    });
  });
});
