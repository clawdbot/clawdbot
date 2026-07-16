import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const liveEnabled = HAS_OPENAI_KEY && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

function installTmpDirHarness(params: { prefix: string }) {
  let tmpDir = "";
  let dbPath = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), params.prefix));
    dbPath = path.join(tmpDir, "lancedb");
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  return {
    getTmpDir: () => tmpDir,
    getDbPath: () => dbPath,
  };
}

// Live tests that require OpenAI API key and actually use LanceDB
describeLive("memory plugin live tests", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-live-" });

  test("memory tools work end-to-end", async () => {
    const { default: memoryPlugin } = await import("./index.js");
    const liveApiKey = OPENAI_API_KEY;

    // Mock plugin API
    const registeredTools: any[] = [];
    const registeredClis: any[] = [];
    const registeredServices: any[] = [];
    const registeredHooks: Record<string, any[]> = {};
    const logs: string[] = [];

    const mockApi = {
      id: "memory-lancedb",
      name: "Memory (LanceDB)",
      source: "test",
      config: {},
      pluginConfig: {
        embedding: {
          apiKey: liveApiKey,
          model: "text-embedding-3-small",
        },
        dbPath: getDbPath(),
        autoCapture: false,
        autoRecall: false,
      },
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      registerTool: (tool: any, opts: any) => {
        registeredTools.push({ tool, opts });
      },
      registerCli: (registrar: any, opts: any) => {
        registeredClis.push({ registrar, opts });
      },
      registerService: (service: any) => {
        registeredServices.push(service);
      },
      on: (hookName: string, handler: any) => {
        if (!registeredHooks[hookName]) {
          registeredHooks[hookName] = [];
        }
        registeredHooks[hookName].push(handler);
      },
      resolvePath: (p: string) => p,
    };

    // Register plugin
    memoryPlugin.register(mockApi as any);

    // Check registration
    expect(registeredTools.length).toBe(3);
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_recall");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_store");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_forget");
    expect(registeredClis.length).toBe(1);
    expect(registeredServices.length).toBe(1);

    // Get tool functions
    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const recallTool = registeredTools.find((t) => t.opts?.name === "memory_recall")?.tool;
    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;

    // Test store
    const storeResult = await storeTool.execute("test-call-1", {
      text: "The user prefers dark mode for all applications",
      importance: 0.8,
      category: "preference",
    });

    expect(storeResult.details?.action).toBe("created");
    const storedId = storeResult.details?.id;
    expect(storedId).toMatch(/.+/);

    // Test recall
    const recallResult = await recallTool.execute("test-call-2", {
      query: "dark mode preference",
      limit: 5,
    });

    expect(recallResult.details?.count).toBeGreaterThan(0);
    expect(recallResult.details?.memories?.[0]?.text).toContain("dark mode");

    // Test duplicate detection
    const duplicateResult = await storeTool.execute("test-call-3", {
      text: "The user prefers dark mode for all applications",
    });

    expect(duplicateResult.details?.action).toBe("duplicate");

    // Test forget
    const forgetResult = await forgetTool.execute("test-call-4", {
      memoryId: storedId,
    });

    expect(forgetResult.details?.action).toBe("deleted");

    // Verify it's gone
    const recallAfterForget = await recallTool.execute("test-call-5", {
      query: "dark mode preference",
      limit: 5,
    });

    expect(recallAfterForget.details?.count).toBe(0);
  }, 60000); // 60s timeout for live API calls
});
