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

async function listenHealthz(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
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

async function requestHealthzAfter(port: number, delayMs: number) {
  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  return { elapsedMs: performance.now() - startedAt, response };
}

afterEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.clearAllMocks();
});

describe("Gateway prepared model runtime startup", () => {
  it("keeps health probes responsive without executing live provider catalogs", async () => {
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
    providerMocks.staticCatalog.mockResolvedValue(providerConfig);
    providerMocks.liveCatalog.mockImplementation(async () => {
      const stopAt = performance.now() + 1_500;
      while (performance.now() < stopAt) {
        // Deliberately model synchronous provider/plugin catalog work that starves timers.
      }
      return providerConfig;
    });
    const healthServer = await listenHealthz();

    try {
      await withEnvAsync(
        {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const probe = requestHealthzAfter(healthServer.port, 25);
          const sidecars = startGatewaySidecars({
            cfg,
            pluginRegistry: { plugins: [], typedHooks: [] } as never,
            defaultWorkspaceDir: workspaceDir,
            deps: {} as never,
            startChannels: vi.fn(async () => {}),
            shouldStartPluginServices: () => false,
            log: { warn: vi.fn() },
            logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            logChannels: { info: vi.fn(), error: vi.fn() },
          });

          const [{ elapsedMs, response }] = await Promise.all([probe, sidecars]);
          expect(response.status).toBe(200);
          // Allow loaded CI hosts to finish static startup work while keeping the
          // deliberately blocking live-catalog path well outside the guard.
          expect(elapsedMs).toBeLessThan(1_000);
          expect(providerMocks.staticCatalog).toHaveBeenCalled();
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
