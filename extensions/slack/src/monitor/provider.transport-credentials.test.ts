import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { handleSlackHttpRequest } from "../http/index.js";
import { setSlackRuntime } from "../runtime.js";
import { monitorSlackProvider } from "./provider.js";

const inactiveSecret = { source: "env", provider: "default", id: "SLACK_UNUSED_SECRET" } as const;
const signingSecret = "loopback-signing-secret";

async function startSlackLoopback() {
  const requests: string[] = [];
  const connections: Array<{ url?: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    void handleSlackHttpRequest(request, response).then((handled) => {
      if (handled) {
        return;
      }
      request.resume();
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/api/auth.test"
            ? {
                ok: true,
                user_id: "UBOT",
                bot_id: "BBOT",
                app_id: "ATEST",
                team_id: "TTEST",
                is_enterprise_install: false,
              }
            : request.url === "/api/apps.connections.open"
              ? { ok: true, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket` }
              : { ok: false, error: "unexpected_test_request" },
        ),
      );
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    connections.push({ url: request.url, authorization: request.headers.authorization });
    socket.send(JSON.stringify({ type: "hello" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    connections,
    close: async () => {
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => resolve());
      });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("Slack transport credential activation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["socket", "relay", "http"] as const)(
    "starts real %s transport with only its active credentials resolved",
    async (mode) => {
      const loopback = await startSlackLoopback();
      vi.stubEnv("SLACK_API_URL", `${loopback.url}/api/`);
      vi.stubEnv("SLACK_UNUSED_SECRET", "");
      try {
        await withStateDirEnv("slack-transport-credentials-", async ({ stateDir }) => {
          setSlackRuntime({
            state: {
              resolveStateDir: () => stateDir,
              openChannelIngressQueue: (options) =>
                createChannelIngressQueueForTests({ ...options, channelId: "slack", stateDir }),
            },
          } as PluginRuntime);
          const config = {
            channels: {
              slack: {
                mode,
                botToken: "xoxb-loopback",
                appToken: mode === "socket" ? "xapp-1-ATEST-loopback" : inactiveSecret,
                signingSecret: mode === "http" ? signingSecret : inactiveSecret,
                relay: {
                  url: `${loopback.url}/relay`,
                  authToken: mode === "relay" ? "loopback-relay-token" : inactiveSecret,
                  gatewayId: "loopback",
                },
              },
            },
          } satisfies OpenClawConfig;
          const connected = createDeferred<void>();
          const controller = new AbortController();
          const run = monitorSlackProvider({
            config,
            abortSignal: controller.signal,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            setStatus: (next) => {
              if (next.connected === true) {
                connected.resolve();
              }
            },
          });
          try {
            await Promise.race([connected.promise, run]);
            expect(loopback.requests).toContain("/api/auth.test");
            if (mode === "socket") {
              expect(loopback.requests).toContain("/api/apps.connections.open");
              expect(loopback.connections).toContainEqual({
                url: expect.stringMatching(/^\/socket(?:\?|$)/u),
                authorization: undefined,
              });
            } else if (mode === "relay") {
              expect(loopback.connections).toContainEqual({
                url: "/relay?gateway_id=loopback",
                authorization: "Bearer loopback-relay-token",
              });
            } else {
              const body = JSON.stringify({ type: "url_verification", challenge: "connected" });
              const timestamp = String(Math.floor(Date.now() / 1_000));
              const signature = createHmac("sha256", signingSecret)
                .update(`v0:${timestamp}:${body}`)
                .digest("hex");
              const postChallenge = (signatureValue: string) =>
                fetch(`${loopback.url}/slack/events`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-slack-request-timestamp": timestamp,
                    "x-slack-signature": signatureValue,
                  },
                  body,
                });
              const valid = await postChallenge(`v0=${signature}`);
              expect(valid.status).toBe(200);
              expect(await valid.text()).toContain("connected");
              expect((await postChallenge("v0=invalid")).status).toBe(401);
            }
          } finally {
            controller.abort();
            await run;
          }
        });
      } finally {
        await loopback.close();
      }
    },
  );

  it("rejects an unresolved signing secret before starting HTTP transport", async () => {
    await expect(
      monitorSlackProvider({
        config: {
          channels: {
            slack: { mode: "http", botToken: "xoxb-loopback", signingSecret: inactiveSecret },
          },
        },
      }),
    ).rejects.toThrow("channels.slack.accounts.default.signingSecret");
  });
});
