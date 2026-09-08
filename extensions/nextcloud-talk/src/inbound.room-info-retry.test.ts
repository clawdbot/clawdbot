// Nextcloud Talk tests cover room-kind lookup retry behavior at the inbound boundary.
import http from "node:http";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

type NextcloudTalkIngressQueue = NonNullable<
  Parameters<typeof createNextcloudTalkWebhookSpool>[0]["queue"]
>;
type NextcloudTalkIngressPayload = Parameters<NextcloudTalkIngressQueue["enqueue"]>[1];

type ProofServer = {
  baseUrl: string;
  requests: string[];
  stop: () => Promise<void>;
};

const servers: ProofServer[] = [];

async function waitForRetryPump(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("timed out waiting for room lookup retry pump");
}

async function startRoomInfoServer(): Promise<ProofServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (requests.length === 1) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("temporary outage");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ocs: { data: { type: 1 } } }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback listener address");
  }
  const proofServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
  servers.push(proofServer);
  return proofServer;
}

function installRuntime(dispatches: { count: number }): void {
  setNextcloudTalkRuntime({
    channel: {
      inbound: {
        buildContext: (payload: unknown) => payload,
        dispatch: async () => {
          dispatches.count += 1;
        },
      },
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => ({ code: "123456", created: true }),
      },
      commands: {
        shouldHandleTextCommands: () => false,
      },
      text: {
        hasControlCommand: () => false,
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
      },
    },
  } as never);
}

function createAccount(baseUrl: string, allowPrivateNetwork = true): ResolvedNextcloudTalkAccount {
  return {
    accountId: "proof",
    enabled: true,
    baseUrl,
    secret: "bot-secret",
    secretSource: "config",
    config: {
      apiUser: "bot",
      apiPassword: "secret",
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      network: { dangerouslyAllowPrivateNetwork: allowPrivateNetwork },
    },
  };
}

function createRawWebhookEvent(params?: { roomToken?: string }): string {
  return JSON.stringify({
    type: "Create",
    actor: { type: "Person", id: "user-1", name: "Alice" },
    object: {
      type: "Note",
      id: "msg-proof",
      name: "hello",
      content: "hello",
      mediaType: "text/plain",
    },
    target: { type: "Collection", id: params?.roomToken ?? "room-direct", name: "Direct room" },
  });
}

function startSpool(params: {
  queue: NextcloudTalkIngressQueue;
  serverBaseUrl: string;
  runtime: RuntimeEnv;
  allowPrivateNetwork?: boolean;
  config?: CoreConfig;
}) {
  return createNextcloudTalkWebhookSpool({
    accountId: "proof",
    queue: params.queue,
    deliver: async (message, lifecycle) =>
      await handleNextcloudTalkInbound({
        message,
        account: createAccount(params.serverBaseUrl, params.allowPrivateNetwork ?? true),
        config: params.config ?? ({ channels: { "nextcloud-talk": {} } } as CoreConfig),
        runtime: params.runtime,
        turnAdoptionLifecycle: lifecycle,
      }),
    runtime: params.runtime,
    pollIntervalMs: 10,
    adoptionStallTimeoutMs: 5_000,
    legacyReplayStore: null,
  });
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.stop()));
  closeOpenClawStateDatabaseForTest();
});

describe("nextcloud-talk inbound room-kind lookup retry", () => {
  it("retries a failed room lookup in the same running spool and dispatches once", async () => {
    const server = await startRoomInfoServer();
    const dispatches = { count: 0 };
    const logs: string[] = [];
    installRuntime(dispatches);
    const runtime: RuntimeEnv = {
      error: (messageValue: unknown) => logs.push(String(messageValue)),
      exit: () => {},
      log: (messageValue: unknown) => logs.push(String(messageValue)),
    };

    await withTempDir("openclaw-nextcloud-talk-room-info-retry-", async (stateDir) => {
      const queue = createChannelIngressQueueForTests<NextcloudTalkIngressPayload>({
        channelId: "nextcloud-talk",
        accountId: "proof",
        stateDir,
      });
      const spool = startSpool({ queue, serverBaseUrl: server.baseUrl, runtime });
      try {
        await spool.receive(createRawWebhookEvent({ roomToken: "room-durable-direct" }));
        await spool.waitForIdle();
        await waitForRetryPump(() => dispatches.count === 1);
        await spool.waitForIdle();

        expect(dispatches.count).toBe(1);
        expect(server.requests).toHaveLength(2);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        await spool.stop();
      }
    });

    expect(logs).toContain(
      "nextcloud-talk spooled update msg-proof failed; keeping for retry: Nextcloud Talk room lookup failed (503)",
    );
  });

  it("keeps guarded-fetch policy blocks on the fallback path instead of durable retry", async () => {
    const server = await startRoomInfoServer();
    const dispatches = { count: 0 };
    const logs: string[] = [];
    installRuntime(dispatches);
    const runtime: RuntimeEnv = {
      error: (messageValue: unknown) => logs.push(String(messageValue)),
      exit: () => {},
      log: (messageValue: unknown) => logs.push(String(messageValue)),
    };

    await withTempDir("openclaw-nextcloud-talk-room-info-policy-", async (stateDir) => {
      const queue = createChannelIngressQueueForTests<NextcloudTalkIngressPayload>({
        channelId: "nextcloud-talk",
        accountId: "proof",
        stateDir,
      });
      const spool = startSpool({
        queue,
        serverBaseUrl: server.baseUrl,
        runtime,
        allowPrivateNetwork: false,
      });
      try {
        await spool.receive(createRawWebhookEvent({ roomToken: "room-policy-blocked" }));
        await spool.waitForIdle();

        expect(server.requests).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
        expect(dispatches.count).toBe(0);
      } finally {
        await spool.stop();
      }
    });
  });

  it("keeps invalid room lookup URLs on the fallback path instead of durable retry", async () => {
    const server = await startRoomInfoServer();
    const dispatches = { count: 0 };
    const logs: string[] = [];
    installRuntime(dispatches);
    const runtime: RuntimeEnv = {
      error: (messageValue: unknown) => logs.push(String(messageValue)),
      exit: () => {},
      log: (messageValue: unknown) => logs.push(String(messageValue)),
    };

    await withTempDir("openclaw-nextcloud-talk-room-info-invalid-url-", async (stateDir) => {
      const queue = createChannelIngressQueueForTests<NextcloudTalkIngressPayload>({
        channelId: "nextcloud-talk",
        accountId: "proof",
        stateDir,
      });
      const spool = startSpool({
        queue,
        serverBaseUrl: "not-a-url",
        runtime,
        config: {
          channels: {
            "nextcloud-talk": {
              rooms: {
                "room-invalid-url": { requireMention: false },
              },
            },
          },
        } as CoreConfig,
      });
      try {
        await spool.receive(createRawWebhookEvent({ roomToken: "room-invalid-url" }));
        await spool.waitForIdle();

        expect(dispatches.count).toBe(1);
        expect(server.requests).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        await spool.stop();
      }
    });
  });
});
