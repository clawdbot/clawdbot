import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS } from "./config.js";
import {
  configureCommitmentExtractionRuntime,
  drainCommitmentExtractionQueue,
  enqueueCommitmentExtraction,
  resetCommitmentExtractionRuntimeForTests,
} from "./runtime.js";
import { loadCommitmentStore } from "./store.js";
import type { CommitmentExtractionBatchResult, CommitmentExtractionItem } from "./types.js";

const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());
const resolveDefaultModelMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

vi.mock("./model-selection.runtime.js", () => ({
  resolveCommitmentDefaultModelRef: resolveDefaultModelMock,
}));

function requireFirstEmbeddedPiRequest(): {
  provider?: string;
  model?: string;
  disableTools?: boolean;
} {
  const [call] = runEmbeddedPiAgentMock.mock.calls;
  if (!call) {
    throw new Error("expected embedded PI agent extraction request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected embedded PI agent extraction request");
  }
  return request as { provider?: string; model?: string; disableTools?: boolean };
}

describe("commitment extraction runtime", () => {
  const tmpDirs: string[] = [];
  const nowMs = Date.parse("2026-04-29T16:00:00.000Z");

  afterEach(async () => {
    resetCommitmentExtractionRuntimeForTests();
    runEmbeddedPiAgentMock.mockReset();
    resolveDefaultModelMock.mockReset();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function createConfig(): Promise<OpenClawConfig> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commitment-runtime-"));
    tmpDirs.push(tmpDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    return {
      commitments: {
        enabled: true,
      },
    };
  }

  it("does not enqueue background extraction in test mode unless forced", async () => {
    const cfg = await createConfig();

    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs,
        agentId: "main",
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
        userText: "Interview tomorrow.",
        assistantText: "Good luck.",
      }),
    ).toBe(false);
  });

  it("keeps hidden extraction opt-in by default", () => {
    const cfg: OpenClawConfig = {
      commitments: {},
    };
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs,
        agentId: "main",
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
        userText: "Interview tomorrow.",
        assistantText: "Good luck.",
      }),
    ).toBe(false);
  });

  it("micro-batches queued turns into one extractor call", async () => {
    const cfg = await createConfig();
    const extractBatch = vi.fn(async ({ items }: { items: CommitmentExtractionItem[] }) => ({
      candidates: items.map((item, index) => ({
        itemId: item.itemId,
        kind: "event_check_in" as const,
        sensitivity: "routine" as const,
        source: "inferred_user_context" as const,
        reason: `Follow up ${index + 1}`,
        suggestedText: `How did item ${index + 1} go?`,
        dedupeKey: `event:${index + 1}`,
        confidence: 0.93,
        dueWindow: {
          earliest: "2026-04-30T17:00:00.000Z",
          latest: "2026-04-30T23:00:00.000Z",
          timezone: "America/Los_Angeles",
        },
      })),
    }));
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      extractBatch,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs,
        agentId: "main",
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
        to: "15551234567",
        sourceMessageId: "m1",
        userText: "I have an interview tomorrow.",
        assistantText: "Good luck.",
      }),
    ).toBe(true);
    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs: nowMs + 1,
        agentId: "main",
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
        to: "15551234567",
        sourceMessageId: "m2",
        userText: "I have a dentist appointment tomorrow.",
        assistantText: "Hope it goes smoothly.",
      }),
    ).toBe(true);

    await expect(drainCommitmentExtractionQueue()).resolves.toBe(2);
    const store = await loadCommitmentStore();

    expect(extractBatch).toHaveBeenCalledTimes(1);
    const [extractCall] = extractBatch.mock.calls;
    if (!extractCall) {
      throw new Error("Expected commitment extraction batch call");
    }
    const batchItems = extractCall[0].items;
    expect(batchItems).toHaveLength(2);
    const [firstBatchItem] = batchItems;
    if (!firstBatchItem) {
      throw new Error("Expected first commitment extraction batch item");
    }
    expect(firstBatchItem.itemId).not.toContain("main");
    expect(firstBatchItem.itemId).not.toContain("telegram");
    expect(firstBatchItem.itemId).not.toContain("15551234567");
    expect(firstBatchItem.itemId).not.toContain("m1");
    expect(store.commitments.map((commitment) => commitment.dedupeKey)).toEqual([
      "event:1",
      "event:2",
    ]);
    expect(store.commitments[0]).not.toHaveProperty("sourceUserText");
    expect(store.commitments[0]).not.toHaveProperty("sourceAssistantText");
  });

  it("uses the configured agent model for the hidden extractor run", async () => {
    const cfg = await createConfig();
    cfg.agents = {
      defaults: {
        model: {
          primary: "openai-codex/gpt-5.5",
        },
      },
    };
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: '{"candidates":[]}' }],
    });
    resolveDefaultModelMock.mockReturnValue({
      provider: "openai-codex",
      model: "gpt-5.5",
    });
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs,
        agentId: "main",
        sessionKey: "agent:main:discord:channel-1",
        channel: "discord",
        userText: "I have an interview tomorrow.",
        assistantText: "Good luck.",
      }),
    ).toBe(true);

    await expect(drainCommitmentExtractionQueue()).resolves.toBe(1);
    expect(resolveDefaultModelMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const request = requireFirstEmbeddedPiRequest();
    expect(request.provider).toBe("openai-codex");
    expect(request.model).toBe("gpt-5.5");
    expect(request.disableTools).toBe(true);
  });

  it("backs off hidden extraction after terminal model or auth failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const cfg = await createConfig();
    const extractBatch = vi.fn(async () => {
      throw new Error(
        'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth.',
      );
    });
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      extractBatch,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs,
        agentId: "main",
        sessionKey: "agent:main:discord:channel-1",
        channel: "discord",
        userText: "I have an interview tomorrow.",
        assistantText: "Good luck.",
      }),
    ).toBe(true);

    await expect(drainCommitmentExtractionQueue()).rejects.toThrow("No API key found");
    expect(extractBatch).toHaveBeenCalledTimes(1);
    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs: nowMs + 1,
        agentId: "main",
        sessionKey: "agent:main:discord:channel-1",
        channel: "discord",
        userText: "The interview is tomorrow.",
        assistantText: "I hope it goes well.",
      }),
    ).toBe(false);
    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs: nowMs + 1,
        agentId: "other",
        sessionKey: "agent:other:discord:channel-2",
        channel: "discord",
        userText: "The demo is tomorrow.",
        assistantText: "I hope it goes well.",
      }),
    ).toBe(true);

    vi.setSystemTime(nowMs + 16 * 60_000);
    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs: nowMs + 16 * 60_000,
        agentId: "main",
        sessionKey: "agent:main:discord:channel-1",
        channel: "discord",
        userText: "The interview is tomorrow.",
        assistantText: "I hope it goes well.",
      }),
    ).toBe(true);
  });

  it("bounds hidden extraction queue growth before spending extractor tokens", async () => {
    const cfg = await createConfig();
    const extractBatch = vi.fn(
      async (_params: {
        items: CommitmentExtractionItem[];
      }): Promise<CommitmentExtractionBatchResult> => ({
        candidates: [],
      }),
    );
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      extractBatch,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    for (let index = 0; index < DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS; index += 1) {
      expect(
        enqueueCommitmentExtraction({
          cfg,
          nowMs: nowMs + index,
          agentId: "main",
          sessionKey: "agent:main:telegram:user-1",
          channel: "telegram",
          to: "15551234567",
          sourceMessageId: `m${index}`,
          userText: `Commitment candidate ${index}`,
          assistantText: "I will follow up.",
        }),
      ).toBe(true);
    }

    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs: nowMs + DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
        agentId: "main",
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
        to: "15551234567",
        sourceMessageId: "overflow",
        userText: "Overflow candidate",
        assistantText: "I will follow up.",
      }),
    ).toBe(false);

    await expect(drainCommitmentExtractionQueue()).resolves.toBe(
      DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
    );
    const processed = extractBatch.mock.calls.reduce(
      (count, call) => count + (call[0]?.items.length ?? 0),
      0,
    );
    expect(processed).toBe(DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS);
  });
});
