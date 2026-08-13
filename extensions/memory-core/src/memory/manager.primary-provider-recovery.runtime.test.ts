// Memory Core tests cover configured-runtime primary provider recovery.
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { closeAllMemorySearchManagers } from "./index.js";
import { closeAllMemoryIndexManagers, MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

type CapturedEmbeddingRequest = {
  body: {
    input?: unknown;
    model?: unknown;
  };
  provider: "primary" | "fallback";
};

type EmbeddingServer = {
  baseUrl: string;
  close: () => Promise<void>;
  requests: CapturedEmbeddingRequest[];
  setPrimaryAvailable: (available: boolean) => void;
  holdPrimaryBatches: () => { release: () => void };
};

const previousStateDir = process.env.OPENCLAW_STATE_DIR;
let previousRegistry: ReturnType<typeof getActivePluginRegistry>;
let fixtureRoot = "";
let server: EmbeddingServer | null = null;

function restoreStateDir(): void {
  if (previousStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", previousStateDir);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startEmbeddingServer(): Promise<EmbeddingServer> {
  let primaryAvailable = false;
  let primaryBatchGate: Promise<void> | null = null;
  const requests: CapturedEmbeddingRequest[] = [];
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        const auth = req.headers.authorization ?? "";
        const provider = auth.includes("fallback-test-token") ? "fallback" : "primary";
        requests.push({ body, provider });
        if (provider === "primary" && !primaryAvailable) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "primary unavailable" } }));
          return;
        }
        if (provider === "primary" && Array.isArray(body.input) && primaryBatchGate) {
          await primaryBatchGate;
        }
        const input = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: input.map((value, index) => ({
              object: "embedding",
              embedding: [provider === "primary" ? 1 : 0, String(value ?? "").length, index + 0.5],
              index,
            })),
            model: body.model,
          }),
        );
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setPrimaryAvailable: (available) => {
      primaryAvailable = available;
    },
    holdPrimaryBatches: () => {
      let release: () => void = () => {};
      primaryBatchGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        release: () => {
          primaryBatchGate = null;
          release();
        },
      };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function withStepTimeout<T>(label: string, promise: Promise<T>, ms = 30_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function createConfig(params: { baseUrl: string; workspaceDir: string }): OpenClawConfig {
  return isolateMemoryManagerTestConfig({
    memory: {
      search: {
        provider: "primary-runtime",
        model: "primary-embed",
        fallback: "fallback-runtime",
        query: { minScore: 0 },
      },
    },
    agents: {
      defaults: { workspace: params.workspaceDir },
      list: [{ id: "main", default: true }],
    },
    models: {
      providers: {
        "primary-runtime": {
          api: "openai-completions",
          baseUrl: params.baseUrl,
          apiKey: "primary-test-token",
          models: [],
        },
        "fallback-runtime": {
          api: "openai-completions",
          baseUrl: params.baseUrl,
          apiKey: "fallback-test-token",
          models: [],
        },
      },
    },
  });
}

describe("memory manager configured runtime primary provider recovery", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    previousRegistry = getActivePluginRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
    // openclaw-temp-dir: allow extension tests cannot import root test helpers; afterEach removes it.
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-runtime-recovery-"));
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
    const memoryDir = path.join(fixtureRoot, "workspace", "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-08-06.md"),
      "# Runtime proof\nAlpha runtime memory line.",
    );
    await configureMemoryCoreDreamingStateForTests();
    server = await startEmbeddingServer();
  });

  afterEach(async () => {
    await closeAllMemorySearchManagers();
    await closeAllMemoryIndexManagers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetMemoryCoreDreamingStateForTests();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    await server?.close();
    server = null;
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    restoreStateDir();
  });

  it("keeps fallback searches live until primary transport reindex succeeds", async () => {
    if (!server) {
      throw new Error("missing embedding server");
    }
    const cfg = createConfig({
      baseUrl: server.baseUrl,
      workspaceDir: path.join(fixtureRoot, "workspace"),
    });
    const manager = await withStepTimeout(
      "manager creation",
      MemoryIndexManager.get({ cfg, agentId: "main" }),
    );
    if (!manager) {
      throw new Error("missing memory manager");
    }
    server.setPrimaryAvailable(true);
    await withStepTimeout(
      "initial primary sync",
      expect(manager.sync({ reason: "test", force: true })).resolves.toBeUndefined(),
    );
    server.setPrimaryAvailable(false);
    await withStepTimeout(
      "fallback activation search",
      expect(manager.search("alpha runtime")).resolves.toEqual([]),
    );
    expect(manager.status().provider).toBe("openai-compatible");
    expect(manager.status().fallback?.from).toBe("openai-compatible");
    await withStepTimeout(
      "fallback sync",
      expect(manager.sync({ reason: "test", force: true })).resolves.toBeUndefined(),
    );
    await withStepTimeout(
      "fallback live search",
      expect(manager.search("alpha runtime")).resolves.not.toStrictEqual([]),
    );
    expect(server.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({ model: "primary-embed" }),
          provider: "primary",
        }),
        expect.objectContaining({
          body: expect.objectContaining({ model: "primary-embed" }),
          provider: "fallback",
        }),
      ]),
    );

    const requestsBeforeRecovery = server.requests.length;
    server.setPrimaryAvailable(true);
    await withStepTimeout(
      "search while primary recovery is scheduled",
      expect(manager.search("alpha runtime")).resolves.not.toStrictEqual([]),
    );

    await withStepTimeout(
      "primary recovery wait",
      vi.waitFor(() => {
        expect(manager.status().model).toBe("primary-embed");
        expect(manager.status().fallback).toBeUndefined();
        expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      }),
    );
    expect(
      server.requests.slice(requestsBeforeRecovery).map((request) => request.provider),
    ).toEqual(expect.arrayContaining(["primary"]));
  });

  it("keeps fallback searches live while the primary recovery reindex is held open", async () => {
    if (!server) {
      throw new Error("missing embedding server");
    }
    const cfg = createConfig({
      baseUrl: server.baseUrl,
      workspaceDir: path.join(fixtureRoot, "workspace"),
    });
    const manager = await withStepTimeout(
      "manager creation",
      MemoryIndexManager.get({ cfg, agentId: "main" }),
    );
    if (!manager) {
      throw new Error("missing memory manager");
    }
    server.setPrimaryAvailable(true);
    await withStepTimeout(
      "initial primary sync",
      expect(manager.sync({ reason: "test", force: true })).resolves.toBeUndefined(),
    );
    server.setPrimaryAvailable(false);
    await withStepTimeout(
      "fallback activation search",
      expect(manager.search("alpha runtime")).resolves.toEqual([]),
    );
    await withStepTimeout(
      "fallback sync",
      expect(manager.sync({ reason: "test", force: true })).resolves.toBeUndefined(),
    );
    await withStepTimeout(
      "fallback live search",
      expect(manager.search("alpha runtime")).resolves.not.toStrictEqual([]),
    );

    // Hold only the primary's batch reindex; the recovery probe ping stays
    // free so recovery reaches the shadow build and stalls there.
    const heldBatches = server.holdPrimaryBatches();
    const requestsBeforeRecovery = server.requests.length;
    server.setPrimaryAvailable(true);
    await withStepTimeout(
      "search scheduling primary recovery",
      expect(manager.search("alpha runtime")).resolves.not.toStrictEqual([]),
    );
    await withStepTimeout(
      "recovery reindex start",
      vi.waitFor(() => {
        const heldRequest = server!.requests
          .slice(requestsBeforeRecovery)
          .find((request) => request.provider === "primary" && Array.isArray(request.body.input));
        expect(heldRequest).toBeDefined();
      }),
    );

    // The primary reindex is stalled on the held batch; a fallback search
    // admitted now must still return fallback results without waiting.
    await withStepTimeout(
      "fallback search during held primary reindex",
      expect(manager.search("alpha runtime")).resolves.not.toStrictEqual([]),
    );
    expect(manager.status().fallback).toBeDefined();
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });

    heldBatches.release();
    await withStepTimeout(
      "primary recovery wait",
      vi.waitFor(() => {
        expect(manager.status().model).toBe("primary-embed");
        expect(manager.status().fallback).toBeUndefined();
        expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      }),
    );
  });
});
