// Memory Core tests cover prompt-only dreaming and publication boundaries.
import fs from "node:fs/promises";
import path from "node:path";
import { RequestScopedSubagentRuntimeError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecentDreamDiaryEntries, writeBackfillDiaryEntries } from "./dreaming-dreams-file.js";
import { runDreamNarrative, type DreamingCompletion } from "./dreaming-narrative.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { SESSION_CORPUS_RELATIVE_DIR } from "./session-ingestion.js";
import { readShortTermRecallEntries, recordShortTermRecalls } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
function setNarrativeTestEnv(stateDir: string): void {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
}
function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
function expectLogIncludes(source: ReturnType<typeof vi.fn>, text: string) {
  expect(source.mock.calls.some((call) => String(call[0]).includes(text))).toBe(true);
}
function createCompletion(text = "The repository whispered of forgotten endpoints.") {
  return { complete: vi.fn<DreamingCompletion["complete"]>().mockResolvedValue({ text }) };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runDreamNarrative", () => {
  it("writes the completion using the workspace owner's configured model", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-completion-");
    const subagent = createCompletion();
    const outcome = await runDreamNarrative({
      agentId: "researcher",
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["API endpoints need authentication"] },
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
      model: "anthropic/claude-sonnet-4-6",
      logger: createLogger(),
    });

    expect(subagent.complete).toHaveBeenCalledOnce();
    expect(subagent.complete.mock.calls[0]?.[0]).toMatchObject({
      agentId: "researcher",
      model: "anthropic/claude-sonnet-4-6",
      timeoutMs: 60_000,
      message: expect.stringContaining("API endpoints need authentication"),
      extraSystemPrompt: expect.stringContaining("Output ONLY the diary entry"),
    });
    expect(outcome).toEqual({ status: "completed" });
    expect(await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8")).toContain(
      "The repository whispered of forgotten endpoints.",
    );
  });

  it.each([
    new Error("model unavailable"),
    new Error("Completion failed", { cause: new Error("unknown model: ollama/missing-model") }),
  ])("retries an unavailable configured model with the default (%s)", async (error) => {
    const workspaceDir = await createTempWorkspace("dreaming-model-retry-");
    const subagent = createCompletion("The default model carried the diary home.");
    subagent.complete.mockRejectedValueOnce(error);
    await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir,
      data: { phase: "rem", snippets: ["A configured endpoint was absent."] },
      model: "ollama/missing-model",
      logger: createLogger(),
    });

    expect(subagent.complete).toHaveBeenCalledTimes(2);
    expect(subagent.complete.mock.calls[0]?.[0].model).toBe("ollama/missing-model");
    expect(subagent.complete.mock.calls[1]?.[0]).not.toHaveProperty("model");
    expect(await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8")).toContain(
      "The default model carried the diary home.",
    );
  });

  it("does not retry unauthorized model selection even when its cause names an unavailable model", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-model-denied-");
    const subagent = createCompletion();
    subagent.complete.mockRejectedValue(
      Object.assign(
        new Error("model override is not authorized", {
          cause: new Error("unknown model: ollama/missing-model"),
        }),
        { code: "LLM_COMPLETION_NOT_AUTHORIZED" },
      ),
    );
    const logger = createLogger();
    await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["A private raw staging fragment."] },
      model: "ollama/missing-model",
      logger,
    });

    expect(subagent.complete).toHaveBeenCalledOnce();
    expectLogIncludes(logger.warn, "not authorized");
    const diary = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8");
    expect(diary).not.toContain("A private raw staging fragment.");
    expect(diary).toContain("A memory trace surfaced");
  });

  it.each([
    { name: "empty completion", failure: undefined },
    { name: "timeout", failure: new Error("completion timed out") },
    { name: "request-scoped runtime", failure: new RequestScopedSubagentRuntimeError() },
  ])("writes only a generic trace after $name", async ({ failure }) => {
    const workspaceDir = await createTempWorkspace("dreaming-fallback-");
    const subagent = createCompletion("   \n  ");
    if (failure) {
      subagent.complete.mockRejectedValue(failure);
    }
    const outcome = await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir,
      data: { phase: "deep", snippets: ["A private raw staging fragment."] },
      logger: createLogger(),
    });

    expect(outcome).toMatchObject({ status: "degraded" });
    const diary = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8");
    expect(diary).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expect(diary).not.toContain("A private raw staging fragment.");
  });

  it.each(["main", undefined])("skips empty data for owner %s", async (agentId) => {
    const workspaceDir = await createTempWorkspace("dreaming-empty-");
    const subagent = createCompletion();
    await expect(
      runDreamNarrative({
        agentId,
        subagent,
        workspaceDir,
        data: { phase: "light", snippets: [] },
        logger: createLogger(),
      }),
    ).resolves.toEqual({ status: "skipped" });
    expect(subagent.complete).not.toHaveBeenCalled();
    await expect(fs.access(path.join(workspaceDir, "DREAMS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps ownerless sweeps alive with a local trace", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-ownerless-");
    const subagent = createCompletion();
    await runDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["An ownerless memory fragment."] },
      logger: createLogger(),
    });
    expect(subagent.complete).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8")).toContain(
      "A memory trace surfaced",
    );
  });

  it.each([false, true])(
    "detaches publication without an unhandled failure (reject=%s)",
    async (reject) => {
      const workspaceDir = await createTempWorkspace("dreaming-detached-");
      const completion = createDeferred<{ text: string }>();
      const subagent = createCompletion();
      subagent.complete.mockReturnValue(completion.promise);
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        await expect(
          runDreamNarrative({
            agentId: "main",
            subagent,
            workspaceDir,
            data: { phase: "rem", snippets: ["A detached fragment."] },
            logger: createLogger(),
            detached: true,
          }),
        ).resolves.toEqual({ status: "pending" });
        expect(subagent.complete).toHaveBeenCalledOnce();
        if (reject) {
          completion.reject(new Error("completion failed"));
        } else {
          completion.resolve({ text: "A detached memory found its page." });
        }
        await vi.waitFor(async () => {
          const diary = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8");
          expect(diary).toContain(
            reject ? "A memory trace surfaced" : "A detached memory found its page.",
          );
        });
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        completion.resolve({ text: "settled" });
        process.off("unhandledRejection", unhandled);
      }
    },
  );
});

describe("runDreamNarrative deletion boundary", () => {
  it.each([
    { source: "tracked source", mutation: "forget" },
    { source: "prior diary", mutation: "forget" },
    { source: "prior diary", mutation: "unrelated append" },
  ] as const)(
    "validates $source before publishing generated quotes after $mutation",
    async ({ source, mutation }) => {
      const workspaceDir = await createTempWorkspace("dreaming-forget-generated-");
      setNarrativeTestEnv(path.join(workspaceDir, ".state"));
      const nowMs = Date.now();
      const claim = "The private cobalt archive opens every midnight.";
      const retainedClaim = "A public archive is open throughout the afternoon.";
      const sourcePath = "memory/2026-08-26.md";
      const dreamsPath = path.join(workspaceDir, "DREAMS.md");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, sourcePath), `${claim}\n${retainedClaim}\n`);
      await fs.mkdir(path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR, "2026-08-26.txt"),
        `[main:forgotten-narrative-source#L1] ${claim}\n`,
      );
      await fs.writeFile(dreamsPath, "# Dream Diary\n\nA retained public diary entry.\n");
      await recordShortTermRecalls({
        workspaceDir,
        query: "archive opening time",
        signalType: "daily",
        nowMs,
        results: [
          {
            path: sourcePath,
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: claim,
            source: "memory",
            sessionOrigin: { agentId: "main", sessionId: "forgotten-narrative-source" },
          },
          {
            path: sourcePath,
            startLine: 2,
            endLine: 2,
            score: 0.9,
            snippet: retainedClaim,
            source: "memory",
          },
        ],
      });
      const entries = (await readShortTermRecallEntries({ workspaceDir, nowMs })).filter(
        (entry) => entry.snippet === (source === "prior diary" ? retainedClaim : claim),
      );
      if (source === "prior diary") {
        await writeBackfillDiaryEntries({
          workspaceDir,
          preserveExisting: true,
          entries: [{ isoDay: "2026-08-26", bodyLines: [claim] }],
        });
      }
      const waiting = createDeferred<void>();
      const terminal = createDeferred<{ text: string }>();
      const reply = { text: `I remembered: ${claim}` };
      const subagent = {
        complete: vi.fn(async (_params: { message: string }) => {
          waiting.resolve();
          return await terminal.promise;
        }),
      };
      const data = {
        phase: "light" as const,
        snippets: entries.map((entry) => entry.snippet),
        sourceEntryKeys: entries.map((entry) => entry.key),
        ...(source === "prior diary"
          ? { recentDiaryEntries: await readRecentDreamDiaryEntries({ workspaceDir }) }
          : {}),
      };
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const operation = runDreamNarrative({
        agentId: "main",
        subagent,
        workspaceDir,
        data,
        nowMs,
        logger,
      });
      try {
        await waiting.promise;
        expect(subagent.complete.mock.calls[0]?.[0].message).toContain(claim);
        if (mutation === "forget") {
          const forgotten = await forgetMemoryEntries({
            cfg: { agents: { entries: { main: { workspace: workspaceDir } } } },
            agentId: "main",
            sessionIds: ["forgotten-narrative-source"],
          });
          expect(forgotten.artifacts.shortTermEntries).toBe(1);
          expect(await fs.readFile(dreamsPath, "utf8")).not.toContain(claim);
        } else {
          // The original context remains valid even after it falls outside
          // the recent-entry window used to prepare the next narrative.
          await writeBackfillDiaryEntries({
            workspaceDir,
            preserveExisting: true,
            entries: Array.from({ length: 4 }, (_, index) => ({
              isoDay: "2026-08-26",
              bodyLines: [`Another retained diary entry ${index}.`],
            })),
          });
        }
        terminal.resolve(reply);
        const outcome = await operation;
        const content = await fs.readFile(dreamsPath, "utf8");
        expect(content).toContain("A retained public diary entry.");
        if (mutation === "forget") {
          expect(content).not.toContain(claim);
          expect(outcome).toEqual({ status: "skipped" });
          expectLogIncludes(logger.info, "narrative publication skipped");
        } else {
          expect(content).toContain(reply.text);
          expect(outcome).toEqual({ status: "completed" });
        }
      } finally {
        terminal.resolve(reply);
        await operation;
      }
    },
  );
});
