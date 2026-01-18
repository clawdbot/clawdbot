import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async () => []);
const embedQuery = vi.fn(async () => [0.5, 0.5, 0.5]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery,
      embedBatch,
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

describe("memory indexing with OpenAI batches", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    embedBatch.mockClear();
    embedQuery.mockClear();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-mem-batch-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("uses OpenAI batch uploads when enabled", async () => {
    const content = ["hello", "from", "batch"].join("\n\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), content);

    let uploadedRequests: Array<{ custom_id?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/files")) {
        const body = init?.body;
        if (!(body instanceof FormData)) {
          throw new Error("expected FormData upload");
        }
        for (const [key, value] of body.entries()) {
          if (key !== "file") continue;
          if (typeof value === "string") {
            uploadedRequests = value
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { custom_id?: string });
          } else {
            const text = await value.text();
            uploadedRequests = text
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { custom_id?: string });
          }
        }
        return new Response(JSON.stringify({ id: "file_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/batches")) {
        return new Response(JSON.stringify({ id: "batch_1", status: "in_progress" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/batches/batch_1")) {
        return new Response(
          JSON.stringify({ id: "batch_1", status: "completed", output_file_id: "file_out" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/files/file_out/content")) {
        const lines = uploadedRequests.map((request, index) =>
          JSON.stringify({
            custom_id: request.custom_id,
            response: {
              status_code: 200,
              body: { data: [{ embedding: [index + 1, 0, 0], index: 0 }] },
            },
          }),
        );
        return new Response(lines.join("\n"), {
          status: 200,
          headers: { "Content-Type": "application/jsonl" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
            remote: { batch: { enabled: true, wait: true } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;
    const labels: string[] = [];
    await manager.sync({
      force: true,
      progress: (update) => {
        if (update.label) labels.push(update.label);
      },
    });

    const status = manager.status();
    expect(status.chunks).toBeGreaterThan(0);
    expect(embedBatch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    expect(labels.some((label) => label.toLowerCase().includes("batch"))).toBe(true);
  });
});
