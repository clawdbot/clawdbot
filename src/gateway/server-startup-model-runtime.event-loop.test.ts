import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";

const providerMocks = vi.hoisted(() => ({
  liveCatalog: vi.fn(),
  staticCatalog: vi.fn(),
}));

const providerConfig = {
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses" as const,
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          reasoning: true,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    },
  },
};

vi.mock("../plugins/provider-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-discovery.js")>();
  const provider: ProviderPlugin = {
    id: "openai",
    pluginId: "openai",
    label: "OpenAI",
    auth: [],
    catalog: { order: "simple", run: async () => null },
    staticCatalog: { order: "simple", run: async () => null },
  };
  return {
    ...actual,
    resolveRuntimePluginDiscoveryProviders: vi.fn(async () => [provider]),
    runProviderCatalog: providerMocks.liveCatalog,
    runProviderStaticCatalog: providerMocks.staticCatalog,
  };
});

const { resetPreparedModelRuntimeSnapshotsForTest } =
  await import("../agents/prepared-model-runtime.test-support.js");
const { writePersistedAuthProfileStoreRaw } = await import("../agents/auth-profiles/sqlite.js");
const { resolveAgentDir } = await import("../agents/agent-scope.js");
const { startGatewaySidecars } = await import("./server-startup-post-attach.js");

async function listenHealthz(
  onHealthzServed: () => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      onHealthzServed();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, status: "live" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback health server address");
  }
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

afterEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.clearAllMocks();
});

describe("Gateway prepared model runtime startup", () => {
  it("keeps health probes responsive without executing unnecessary provider catalogs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-model-runtime-startup-"));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      plugins: { enabled: false },
    } satisfies OpenClawConfig;
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const agentDir = resolveAgentDir(cfg, "main", env);
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:startup": {
            type: "api_key",
            provider: "openai",
            key: "test-openai-api-key",
          },
        },
        order: { openai: ["openai:startup"] },
      },
      agentDir,
    );
    const blockEventLoop = async () => {
      const stopAt = performance.now() + 1_500;
      while (performance.now() < stopAt) {
        // Deliberately model synchronous provider/plugin catalog work that starves timers.
      }
      return providerConfig;
    };
    providerMocks.staticCatalog.mockImplementation(blockEventLoop);
    providerMocks.liveCatalog.mockImplementation(blockEventLoop);
    const startupEvents: string[] = [];
    const healthServer = await listenHealthz(() => {
      startupEvents.push("health-served");
    });

    try {
      await withEnvAsync(
        {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          let releaseStartup = () => {};
          const startupGate = new Promise<void>((resolve) => {
            releaseStartup = resolve;
          });
          let markStartupBarrierEntered = () => {};
          const startupBarrierEntered = new Promise<void>((resolve) => {
            markStartupBarrierEntered = resolve;
          });
          let startupCompleted = false;
          const sidecars = startGatewaySidecars({
            cfg,
            pluginRegistry: { plugins: [], typedHooks: [] } as never,
            defaultWorkspaceDir: workspaceDir,
            deps: {} as never,
            startChannels: vi.fn(async () => {}),
            onChannelsStarted: async () => {
              startupEvents.push("barrier-entered");
              markStartupBarrierEntered();
              await startupGate;
            },
            shouldStartPluginServices: () => false,
            log: { warn: vi.fn() },
            logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            logChannels: { info: vi.fn(), error: vi.fn() },
          }).then((result) => {
            startupCompleted = true;
            startupEvents.push("startup-complete");
            return result;
          });

          try {
            await Promise.race([startupBarrierEntered, sidecars]);
            const response = await fetch(`http://127.0.0.1:${healthServer.port}/healthz`);
            expect(response.status).toBe(200);
            startupEvents.push("HTTP200");
            expect(startupEvents).toEqual(["barrier-entered", "health-served", "HTTP200"]);
            expect(startupCompleted).toBe(false);
          } finally {
            startupEvents.push("release");
            releaseStartup();
            await sidecars;
          }

          expect(startupEvents).toEqual([
            "barrier-entered",
            "health-served",
            "HTTP200",
            "release",
            "startup-complete",
          ]);
          console.info(`[gateway-startup-proof] ${startupEvents.join(" -> ")}`);
          expect(providerMocks.staticCatalog).not.toHaveBeenCalled();
          expect(providerMocks.liveCatalog).not.toHaveBeenCalled();
        },
      );
    } finally {
      await healthServer.close();
      closeOpenClawAgentDatabasesForTest();
      await rm(root, { recursive: true, force: true });
    }
  });
});
