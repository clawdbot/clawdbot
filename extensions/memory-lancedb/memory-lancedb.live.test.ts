// Memory Lancedb tests cover memory lancedb plugin behavior.
import { describe, expect, test } from "vitest";
import { installTmpDirHarness } from "./test-helpers.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const liveEnabled = HAS_OPENAI_KEY && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

/** Counts real POST requests to the OpenAI embeddings endpoint, without
 * disturbing them -- the mocked-harness coverage for this same scenario
 * (index.test.ts, "re-embeds an already-captured surviving message once its
 * cursor fingerprint is evicted from history") spies on the embeddings
 * client directly; that proves this module's own selection logic but not
 * that a real configured plugin, real OpenAI embeddings endpoint, and real
 * LanceDB storage agree on the same call count (ClawSweeper P1 on #131329:
 * "supplied before/after runs call it through a harness with mocked
 * embedding and LanceDB clients"). */
class OpenAIEmbeddingCallCounter {
  count = 0;
  private readonly realFetch = globalThis.fetch;

  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.openai.com") && url.includes("/embeddings")) {
        this.count += 1;
      }
      return this.realFetch(input, init);
    }) as typeof fetch;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }
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
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);

    // Check registration
    expect(registeredTools.length).toBe(3);
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_recall");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_store");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_forget");
    expect(registeredClis.length).toBe(1);
    expect(registeredServices.length).toBe(1);

    // Get tool functions
    const materialize = (name: string) => {
      const toolOrFactory = registeredTools.find((entry) => entry.opts?.name === name)?.tool;
      return typeof toolOrFactory === "function"
        ? toolOrFactory({ agentId: "main", config: {} })
        : toolOrFactory;
    };
    const storeTool = materialize("memory_store");
    const recallTool = materialize("memory_recall");
    const forgetTool = materialize("memory_forget");
    const storedText = "The user prefers dark mode for all applications";

    // Test store
    const storeResult = await storeTool.execute("test-call-1", {
      text: storedText,
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
      text: storedText,
    });

    expect(duplicateResult.details).toEqual({
      action: "already_present",
      existingId: storedId,
      existingText: storedText,
    });

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

  test("does not re-embed a surviving auto-capture message after real compaction", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const registeredHooks: Record<string, ((...args: unknown[]) => unknown)[]> = {};
    const logs: string[] = [];
    const mockApi = {
      id: "memory-lancedb",
      name: "Memory (LanceDB)",
      source: "test",
      config: {},
      pluginConfig: {
        embedding: { apiKey: OPENAI_API_KEY, model: "text-embedding-3-small" },
        dbPath: getDbPath(),
        autoCapture: true,
        autoRecall: false,
      },
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      registerTool: () => {},
      registerCli: () => {},
      registerService: () => {},
      on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
        (registeredHooks[hookName] ??= []).push(handler);
      },
      resolvePath: (p: string) => p,
    };

    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);
    const agentEnd = registeredHooks.agent_end?.[0];
    expect(agentEnd).toBeTypeOf("function");

    const counter = new OpenAIEmbeddingCallCounter();
    counter.install();
    try {
      const sessionKey = "live-auto-capture-compaction";
      // Turn 1: two capturable facts.
      await agentEnd?.(
        {
          success: true,
          messages: [
            { role: "user", content: "I prefer Helix for editing code every day." },
            { role: "user", content: "I prefer Fish for shell commands every day." },
          ],
        },
        { agentId: "main", sessionKey },
      );
      expect(counter.count).toBe(2);

      // Turn 2 simulates a real compaction: the cursor's tracked message
      // ("...Fish...") is gone, but the earlier "...Helix..." message it
      // already captured survives verbatim, ahead of one genuinely new
      // fact ("...Zed...").
      await agentEnd?.(
        {
          success: true,
          messages: [
            { role: "user", content: "I prefer Helix for editing code every day." },
            { role: "user", content: "I prefer Zed for editing code every day." },
          ],
        },
        { agentId: "main", sessionKey },
      );

      // Real proof of the fix: exactly one more embeddings request fired
      // (for "...Zed..."), not two -- the surviving "...Helix..." message
      // was recognized via its retained fingerprint and never resubmitted
      // to the real embedding endpoint.
      expect(counter.count).toBe(3);
    } finally {
      counter.restore();
    }
  }, 60000);
});
