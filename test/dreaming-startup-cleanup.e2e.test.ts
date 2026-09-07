// A real Gateway restart must remove interrupted Dreaming sessions from its public session list.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { getSessionEntry, upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import {
  appendSqliteSessionTranscriptEventForTest,
  closeOpenClawAgentDatabasesForTest,
} from "../src/plugin-sdk/sqlite-runtime-testing.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const STALE_AGE_MS = 600_000;
const WAIT_OPTIONS = { interval: 50, timeout: 15_000 } as const;
const instances: OpenClawTestInstance[] = [];

type GatewaySessionClient = Awaited<ReturnType<typeof connectGatewayClient>>;

afterEach(async () => {
  await Promise.all(instances.splice(0).map(async (instance) => await instance.cleanup()));
  closeOpenClawAgentDatabasesForTest();
});

async function seedSession(params: {
  agentId: string;
  suffix: string;
  updatedAt: number;
  pluginOwnerId?: string;
  transcript?: boolean;
}): Promise<string> {
  const sessionKey = `agent:${params.agentId}:${params.suffix}`;
  const sessionId = `${params.agentId}-${params.suffix}`;
  await upsertSessionEntry({
    agentId: params.agentId,
    sessionKey,
    entry: {
      sessionId,
      updatedAt: params.updatedAt,
      ...(params.pluginOwnerId ? { pluginOwnerId: params.pluginOwnerId } : {}),
    },
  });
  if (params.transcript) {
    await appendSqliteSessionTranscriptEventForTest({
      agentId: params.agentId,
      sessionId,
      sessionKey,
      event: {
        runId: `dreaming-narrative-${sessionId}`,
        timestamp: params.updatedAt,
        type: "metadata",
      },
    });
  }
  return sessionKey;
}

async function listSessionKeys(client: GatewaySessionClient): Promise<string[]> {
  const result = await client.request<{ sessions: Array<{ key: string }> }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: true,
    limit: 100,
  });
  return result.sessions.map(({ key }) => key);
}

async function connect(instance: OpenClawTestInstance): Promise<GatewaySessionClient> {
  return await connectGatewayClient({
    url: instance.url,
    token: instance.gatewayToken,
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });
}

describe("Gateway dreaming session restart cleanup", () => {
  it("removes stale child sessions after a real restart even when dreaming and cron are disabled", async () => {
    const config = {
      agents: { list: [{ id: "main", default: true }, { id: "worker" }] },
      plugins: {
        enabled: true,
        allow: ["memory-core"],
        slots: { memory: "memory-core" },
        entries: {
          "memory-core": {
            enabled: true,
            config: { dreaming: { enabled: false } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const instance = await createOpenClawTestInstance({
      name: "dreaming-startup-cleanup",
      config,
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
    });
    instances.push(instance);
    instance.state.applyEnv();
    expect(instance.env.OPENCLAW_SKIP_CRON).toBe("1");

    const sentinel = await seedSession({
      agentId: "main",
      suffix: "dreaming-narrative-startup-sentinel",
      updatedAt: Date.now() - STALE_AGE_MS,
      pluginOwnerId: "memory-core",
    });
    await instance.startGateway();
    let client = await connect(instance);

    try {
      // gateway_start fires after the listener opens; observe its first sweep before
      // creating interrupted rows that must survive until the second process starts.
      await vi.waitFor(() => {
        expect(getSessionEntry({ agentId: "main", sessionKey: sentinel }), instance.logs()).toBe(
          undefined,
        );
      }, WAIT_OPTIONS);

      const now = Date.now();
      const stale = await Promise.all([
        ...["light", "rem", "deep", "consolidation"].map(async (phase) =>
          seedSession({
            agentId: "main",
            suffix: `dreaming-narrative-${phase}-interrupted`,
            updatedAt: now - STALE_AGE_MS,
            transcript: true,
            ...(phase === "rem" ? {} : { pluginOwnerId: "memory-core" }),
          }),
        ),
        seedSession({
          agentId: "worker",
          suffix: "dreaming-narrative-worker-interrupted",
          updatedAt: now - STALE_AGE_MS,
          pluginOwnerId: "memory-core",
        }),
      ]);
      const preserved = await Promise.all([
        seedSession({
          agentId: "main",
          suffix: "dreaming-narrative-active-with-transcript",
          updatedAt: now,
          pluginOwnerId: "memory-core",
          transcript: true,
        }),
        seedSession({
          agentId: "main",
          suffix: "dreaming-narrative-active-before-transcript",
          updatedAt: now,
          pluginOwnerId: "memory-core",
        }),
        seedSession({
          agentId: "main",
          suffix: "dreaming-narrative-foreign",
          updatedAt: now - STALE_AGE_MS,
          pluginOwnerId: "other-plugin",
          transcript: true,
        }),
        seedSession({
          agentId: "main",
          suffix: "telegram:group:dreaming-narrative-conversation",
          updatedAt: now - STALE_AGE_MS,
        }),
      ]);

      await vi.waitFor(async () => {
        const keys = await listSessionKeys(client);
        expect(keys, instance.logs()).toEqual(expect.arrayContaining([...stale, ...preserved]));
      }, WAIT_OPTIONS);

      await disconnectGatewayClient(client);
      await instance.stopGateway();
      await instance.startGateway();
      client = await connect(instance);

      await vi.waitFor(async () => {
        const keys = await listSessionKeys(client);
        expect(keys, instance.logs()).toEqual(expect.arrayContaining(preserved));
        for (const sessionKey of stale) {
          expect(keys, instance.logs()).not.toContain(sessionKey);
        }
      }, WAIT_OPTIONS);
    } finally {
      await disconnectGatewayClient(client).catch(() => undefined);
    }
  }, 180_000);
});
