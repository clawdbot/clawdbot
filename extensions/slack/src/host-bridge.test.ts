// Slack tests cover the PoC host-bridge transport boundary.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import {
  createSlackHostBridgeHttpHandler,
  resolveSlackHostBridgeClientOptions,
  SLACK_HOST_BRIDGE_SENTINEL_TOKEN,
} from "./host-bridge.js";
import { createSlackBoltApp, resolveSlackBoltInterop } from "./monitor/provider-support.js";

describe("Slack host bridge", () => {
  it("rejects an invalid host assertion before invoking Bolt", async () => {
    const next = vi.fn();
    const handler = createSlackHostBridgeHttpHandler({
      authToken: "host-auth-token",
      next,
    });
    const response = {
      statusCode: 0,
      end: vi.fn(),
    };

    await handler({ headers: { authorization: "Bearer wrong-token" } } as never, response as never);

    expect(response.statusCode).toBe(401);
    expect(response.end).toHaveBeenCalledWith("Unauthorized");
    expect(next).not.toHaveBeenCalled();
  });

  it("passes the untouched request to Bolt after authenticating the host", async () => {
    const request = {
      headers: { authorization: "Bearer host-auth-token" },
      fullEnvelopeMarker: { event_id: "Ev123", event: { type: "app_mention" } },
    };
    const response = {};
    const next = vi.fn();
    const handler = createSlackHostBridgeHttpHandler({
      authToken: "host-auth-token",
      next,
    });

    await handler(request as never, response as never);

    expect(next).toHaveBeenCalledWith(request, response);
  });

  it("routes threaded Slack Web API calls through the authenticated host proxy", async () => {
    const requests: Array<{ path: string; headers: Headers; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          path: request.url ?? "",
          headers: new Headers(request.headers as Record<string, string>),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, ts: "1700000000.000001" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const client = new WebClient(
        SLACK_HOST_BRIDGE_SENTINEL_TOKEN,
        resolveSlackHostBridgeClientOptions({
          apiUrl: `http://127.0.0.1:${address.port}/api/slack/`,
          authToken: "host-auth-token",
        }),
      );

      await client.chat.postMessage({
        channel: "C123",
        text: "native reply",
        thread_ts: "1699999999.000001",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe("/api/slack/chat.postMessage");
      expect(requests[0]?.headers.get("x-openclaw-slack-host-authorization")).toBe(
        "Bearer host-auth-token",
      );
      expect(requests[0]?.headers.get("authorization")).toBe(
        `Bearer ${SLACK_HOST_BRIDGE_SENTINEL_TOKEN}`,
      );
      const body = new URLSearchParams(requests[0]?.body);
      expect(body.get("channel")).toBe("C123");
      expect(body.get("thread_ts")).toBe("1699999999.000001");
      expect(body.get("text")).toBe("native reply");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("carries a complete real Bolt event into a threaded reply through the host proxy", async () => {
    const requests: Array<{ path: string; headers: Headers; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const path = request.url ?? "";
        requests.push({
          path,
          headers: new Headers(request.headers as Record<string, string>),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            path.endsWith("/auth.test")
              ? {
                  ok: true,
                  app_id: "A123",
                  bot_id: "B123",
                  user_id: "U_BOT",
                  team_id: "T123",
                }
              : { ok: true, ts: "1700000000.000001" },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const bolt = await import("@slack/bolt");
      const { app } = createSlackBoltApp({
        interop: resolveSlackBoltInterop({
          defaultImport: bolt.default,
          namespaceImport: bolt,
        }),
        slackMode: "http",
        token: SLACK_HOST_BRIDGE_SENTINEL_TOKEN,
        signatureVerification: false,
        slackWebhookPath: "/slack/events",
        clientOptions: resolveSlackHostBridgeClientOptions({
          apiUrl: `http://127.0.0.1:${address.port}/api/slack/`,
          authToken: "host-auth-token",
        }),
      });
      app.event("app_mention", async ({ event, client }) => {
        await client.chat.postMessage({
          channel: event.channel,
          text: "native reply",
          thread_ts: event.ts,
        });
      });

      await app.processEvent({
        body: {
          team_id: "T123",
          api_app_id: "A123",
          type: "event_callback",
          event_id: "Ev123",
          event_time: 1_700_000_000,
          event: {
            type: "app_mention",
            user: "U123",
            text: "<@U_BOT> hello",
            channel: "C123",
            ts: "1699999999.000001",
          },
        },
        ack: vi.fn(async () => {}),
      });

      expect(requests.map((request) => request.path)).toEqual([
        "/api/slack/auth.test",
        "/api/slack/chat.postMessage",
      ]);
      for (const request of requests) {
        expect(request.headers.get("x-openclaw-slack-host-authorization")).toBe(
          "Bearer host-auth-token",
        );
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${SLACK_HOST_BRIDGE_SENTINEL_TOKEN}`,
        );
      }
      const reply = new URLSearchParams(requests[1]?.body);
      expect(reply.get("channel")).toBe("C123");
      expect(reply.get("thread_ts")).toBe("1699999999.000001");
      expect(reply.get("text")).toBe("native reply");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
