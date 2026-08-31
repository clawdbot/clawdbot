import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import type { OpenClawConfig } from "../../../../src/plugin-sdk/config-contracts.js";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "../../../../src/plugin-sdk/memory-core-host-status.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const RESTRICTED_MARKER = "SESSION_MEMORY_RESTRICTED_MARKER";
const LEGACY_MARKER = "LEGACY_MEMORY_GRANDFATHERED_MARKER";
const WAIT_TIMEOUT_MS = 30_000;

type GatewayHandle = QaGatewayChild;
type MockHandle = Awaited<ReturnType<typeof startQaMockOpenAiServer>>;
type RpcClient = Awaited<ReturnType<typeof connectGatewayClient>>;

let gatewayOwner: ReturnType<typeof createQaGatewayChild> | undefined;
let gateway: GatewayHandle | undefined;
let mock: MockHandle | undefined;
let restrictedClient: RpcClient | undefined;

afterEach(async () => {
  const cleanups = [
    gatewayOwner ? stopQaGatewayFixture(gatewayOwner) : undefined,
    mock?.stop().catch(() => undefined),
    restrictedClient ? disconnectGatewayClient(restrictedClient).catch(() => undefined) : undefined,
  ].filter((cleanup): cleanup is Promise<void> => cleanup !== undefined);
  gateway = undefined;
  gatewayOwner = undefined;
  mock = undefined;
  restrictedClient = undefined;
  await Promise.all(cleanups);
});

async function waitFor<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}${gateway ? `\n${gateway.logs()}` : ""}`);
}

async function sendAndWait(params: {
  call: GatewayHandle["call"];
  message: string;
  sessionKey: string;
}): Promise<void> {
  const started = (await params.call("chat.send", {
    sessionKey: params.sessionKey,
    message: params.message,
    deliver: false,
    idempotencyKey: randomUUID(),
  })) as { runId?: unknown; status?: unknown };
  if (typeof started.runId !== "string") {
    return;
  }
  const terminal = (await params.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: WAIT_TIMEOUT_MS },
    { timeoutMs: WAIT_TIMEOUT_MS + 5_000 },
  )) as { status?: unknown };
  expect(terminal.status).toBe("ok");
}

function configureMemoryProof(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        compaction: {
          ...cfg.agents?.defaults?.compaction,
          memoryFlush: {
            ...cfg.agents?.defaults?.compaction?.memoryFlush,
            enabled: false,
          },
        },
      },
    },
    hooks: {
      ...cfg.hooks,
      internal: {
        ...cfg.hooks?.internal,
        enabled: true,
        entries: {
          ...cfg.hooks?.internal?.entries,
          "session-memory": { enabled: true, llmSlug: false, messages: 15 },
        },
      },
    },
    plugins: {
      ...cfg.plugins,
      allow: [...new Set([...(cfg.plugins?.allow ?? []), "memory-core"])],
      slots: { ...cfg.plugins?.slots, memory: "none" },
      entries: {
        ...cfg.plugins?.entries,
        "memory-core": {
          enabled: true,
          config: {
            dreaming: {
              enabled: true,
              verboseLogging: true,
              timezone: "UTC",
              storage: { mode: "inline", separateReports: false },
              phases: {
                light: { enabled: true, limit: 20, lookbackDays: 2 },
                rem: { enabled: false },
                deep: { enabled: true, limit: 20, minScore: 1 },
              },
            },
          },
        },
      },
    },
  };
}

describe("memory provenance through a real Gateway", () => {
  test(
    "carries restricted session memory across enabling a memory provider",
    { timeout: 180_000 },
    async () => {
      mock = await startQaMockOpenAiServer();
      gatewayOwner = createQaGatewayChild();
      gateway = await gatewayOwner.start({
        repoRoot: path.resolve(import.meta.dirname, "../../../.."),
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transportBaseUrl: "http://127.0.0.1:9",
        controlUiEnabled: false,
        enabledPluginIds: ["memory-core"],
        mutateConfig: configureMemoryProof,
      });
      restrictedClient = await connectGatewayClient({
        url: gateway.wsUrl,
        token: gateway.token,
        scopes: ["operator.write"],
      });

      const sessionKey = "agent:qa:memory-provenance-e2e";
      await sendAndWait({
        call: restrictedClient.request.bind(restrictedClient),
        sessionKey,
        message: `Remember this stored instruction: ${RESTRICTED_MARKER}`,
      });
      await sendAndWait({ call: gateway.call, sessionKey, message: "/reset" });

      const memoryDir = path.join(gateway.workspaceDir, "memory");
      const capturedFile = await waitFor("session-memory capture", async () => {
        const names = await fs.readdir(memoryDir).catch(() => []);
        for (const name of names) {
          if (!name.endsWith(".md")) {
            continue;
          }
          const content = await fs.readFile(path.join(memoryDir, name), "utf8");
          if (content.includes(RESTRICTED_MARKER)) {
            return name;
          }
        }
        return undefined;
      });

      const day = new Date().toISOString().slice(0, 10);
      const legacyPath = path.join(memoryDir, `${day}-legacy-owner.md`);
      await fs.writeFile(legacyPath, `- ${LEGACY_MARKER}\n`, "utf8");
      expect(await fs.readFile(path.join(memoryDir, capturedFile), "utf8")).toContain(
        RESTRICTED_MARKER,
      );

      await gateway.restartAfterStateMutation(async ({ configPath }) => {
        const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        await fs.writeFile(
          configPath,
          `${JSON.stringify(
            {
              ...config,
              plugins: {
                ...config.plugins,
                slots: { ...config.plugins?.slots, memory: "memory-core" },
              },
            } satisfies OpenClawConfig,
            null,
            2,
          )}\n`,
          "utf8",
        );
      });

      const cursorResult = (await fetch(`${mock.baseUrl}/debug/request-cursor`).then((response) =>
        response.json(),
      )) as { cursor?: unknown };
      expect(typeof cursorResult.cursor).toBe("number");
      const cursor = cursorResult.cursor as number;

      const dreamingJob = (await gateway.call("cron.add", {
        name: "Memory provenance E2E",
        agentId: "qa",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
          lightContext: true,
        },
        delivery: { mode: "none" },
      })) as { id?: unknown };
      expect(typeof dreamingJob.id).toBe("string");
      const startedDreaming = (await gateway.call("cron.run", {
        id: dreamingJob.id,
        mode: "force",
      })) as { runId?: unknown };
      expect(typeof startedDreaming.runId).toBe("string");
      const completedDreaming = await waitFor("completed dreaming cron", async () => {
        const history = (await gateway?.call("cron.runs", {
          id: dreamingJob.id,
          runId: startedDreaming.runId,
          limit: 1,
        })) as
          | { entries?: Array<{ runId?: unknown; status?: unknown; error?: unknown }> }
          | undefined;
        return history?.entries?.find((entry) => entry.runId === startedDreaming.runId);
      });
      expect(completedDreaming).toMatchObject({ status: "ok" });

      const narrativeRequest = await waitFor("tool-free dreaming provider request", async () => {
        const response = await fetch(`${mock?.baseUrl}/debug/requests?after=${cursor}`);
        if (!response.ok) {
          throw new Error(`mock request log returned ${response.status}`);
        }
        const requests = (await response.json()) as Array<{
          allInputText?: unknown;
          body?: Record<string, unknown>;
        }>;
        return requests.find(
          (request) =>
            typeof request.allInputText === "string" &&
            request.allInputText.includes(LEGACY_MARKER),
        );
      });

      expect(narrativeRequest.allInputText).not.toContain(RESTRICTED_MARKER);
      expect(narrativeRequest.body?.tools ?? []).toEqual([]);
      expect(await fs.readFile(legacyPath, "utf8")).toContain(LEGACY_MARKER);
    },
  );
});
