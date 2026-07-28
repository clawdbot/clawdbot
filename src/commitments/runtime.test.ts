// Covers commitment runtime scheduling, extraction, and notification behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { enqueueCommitmentExtraction } from "./runtime.js";
import {
  configureCommitmentExtractionRuntime,
  drainCommitmentExtractionQueue,
  resetCommitmentExtractionRuntimeForTests,
} from "./runtime.test-support.js";
import { readCommitmentsForTest, seedCommitmentsForTest } from "./store.test-utils.js";
import type { CommitmentExtractionBatchResult, CommitmentExtractionItem } from "./types.js";

const DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS = 64;

const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const resolveDefaultModelMock = vi.hoisted(() => vi.fn());
const resolveCommitmentsConfigMock = vi.hoisted(() =>
  vi.fn(() => ({
    enabled: true,
    maxPerDay: 3,
    extraction: {
      debounceMs: 15_000,
      batchMaxItems: 8,
      queueMaxItems: 64,
      confidenceThreshold: 0.72,
      careConfidenceThreshold: 0.86,
      timeoutSeconds: 45,
    },
  })),
);

vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  resolveCommitmentsConfig: resolveCommitmentsConfigMock,
}));

vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

vi.mock("./model-selection.runtime.js", () => ({
  resolveCommitmentDefaultModelRef: resolveDefaultModelMock,
}));

function requireFirstEmbeddedAgentRequest(): {
  provider?: string;
  model?: string;
  disableTools?: boolean;
  sessionFile?: string;
} {
  const [call] = runEmbeddedAgentMock.mock.calls;
  if (!call) {
    throw new Error("expected embedded OpenClaw agent extraction request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected embedded OpenClaw agent extraction request");
  }
  return request as {
    provider?: string;
    model?: string;
    disableTools?: boolean;
    sessionFile?: string;
  };
}

describe("commitment extraction runtime", () => {
  const tmpDirs: string[] = [];
  let stateDirEnvSnapshot: ReturnType<typeof captureEnv> | undefined;
  const nowMs = Date.parse("2026-04-29T16:00:00.000Z");

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    resetCommitmentExtractionRuntimeForTests();
    runEmbeddedAgentMock.mockReset();
    resolveDefaultModelMock.mockReset();
    resolveCommitmentsConfigMock.mockClear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    stateDirEnvSnapshot?.restore();
    stateDirEnvSnapshot = undefined;
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function createConfig(): Promise<OpenClawConfig> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commitment-runtime-"));
    tmpDirs.push(tmpDir);
    stateDirEnvSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
    return {};
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
    const cfg: OpenClawConfig = {};
    resolveCommitmentsConfigMock.mockReturnValueOnce({
      enabled: false,
      maxPerDay: 3,
      extraction: {
        debounceMs: 15_000,
        batchMaxItems: 8,
        queueMaxItems: 64,
        confidenceThreshold: 0.72,
        careConfidenceThreshold: 0.86,
        timeoutSeconds: 45,
      },
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
    const commitments = readCommitmentsForTest();

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
    expect(commitments.map((commitment) => commitment.dedupeKey).toSorted()).toEqual([
      "event:1",
      "event:2",
    ]);
    expect(commitments[0]).not.toHaveProperty("sourceUserText");
    expect(commitments[0]).not.toHaveProperty("sourceAssistantText");
  });

  it("partitions extraction batches by agent", async () => {
    const cfg = await createConfig();
    const extractBatch = vi.fn(async (_params: { items: CommitmentExtractionItem[] }) => ({
      candidates: [],
    }));
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      extractBatch,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    for (const [index, agentId] of ["alpha", "beta", "alpha", "beta"].entries()) {
      expect(
        enqueueCommitmentExtraction({
          cfg,
          nowMs: nowMs + index,
          agentId,
          sessionKey: `agent:${agentId}:telegram:user-1`,
          channel: "telegram",
          sourceMessageId: `m${index}`,
          userText: `Commitment candidate ${index}`,
          assistantText: "I will follow up.",
        }),
      ).toBe(true);
    }

    await expect(drainCommitmentExtractionQueue()).resolves.toBe(4);
    expect(extractBatch).toHaveBeenCalledTimes(2);
    expect(
      extractBatch.mock.calls.map(([params]) => params.items.map((item) => item.agentId)),
    ).toEqual([
      ["alpha", "alpha"],
      ["beta", "beta"],
    ]);
  });

  it("uses the configured agent model for the hidden extractor run", async () => {
    const cfg = await createConfig();
    cfg.agents = {
      defaults: {
        model: {
          primary: "openai/gpt-5.5",
        },
      },
    };
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: '{"candidates":[]}' }],
    });
    resolveDefaultModelMock.mockReturnValue({
      provider: "openai",
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
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const request = requireFirstEmbeddedAgentRequest();
    expect(request.provider).toBe("openai");
    expect(request.model).toBe("gpt-5.5");
    expect(request.disableTools).toBe(true);
    expect(request.sessionFile).toBeUndefined();
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

  it("uses the queued item timestamp for terminal failure cooldowns", async () => {
    const cfg = await createConfig();
    seedCommitmentsForTest([]);
    const extractBatch = vi.fn(async () => {
      throw new Error("OAuth token refresh failed");
    });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
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

    try {
      await expect(drainCommitmentExtractionQueue()).rejects.toThrow("OAuth token refresh failed");
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
    } finally {
      dateNow.mockRestore();
    }
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

  function mapBatchToCandidates({ items }: { items: CommitmentExtractionItem[] }) {
    return {
      candidates: items.map((item, index) => ({
        itemId: item.itemId,
        kind: "event_check_in" as const,
        sensitivity: "routine" as const,
        source: "inferred_user_context" as const,
        reason: `Follow up ${index + 1}`,
        suggestedText: `How did item ${index + 1} go?`,
        dedupeKey: `event:${item.sourceMessageId ?? index}`,
        confidence: 0.93,
        dueWindow: {
          earliest: "2026-04-30T17:00:00.000Z",
          latest: "2026-04-30T23:00:00.000Z",
          timezone: "America/Los_Angeles",
        },
      })),
    };
  }

  it("restores and reprocesses a batch after a non-terminal extractor failure", async () => {
    const cfg = await createConfig();
    let attempts = 0;
    const extractBatch = vi.fn(async (params: { items: CommitmentExtractionItem[] }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient extraction failure");
      }
      return mapBatchToCandidates(params);
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
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
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
        sourceMessageId: "m2",
        userText: "I have a dentist appointment tomorrow.",
        assistantText: "Hope it goes smoothly.",
      }),
    ).toBe(true);

    // First drain: the extractor throws a non-terminal error and nothing persists.
    await expect(drainCommitmentExtractionQueue()).rejects.toThrow("transient extraction failure");
    expect(extractBatch).toHaveBeenCalledTimes(1);
    expect(readCommitmentsForTest()).toHaveLength(0);

    // Retry: the restored batch is reprocessed once, in the same order, with no
    // duplicate persistence or extraction.
    await expect(drainCommitmentExtractionQueue()).resolves.toBe(2);
    expect(extractBatch).toHaveBeenCalledTimes(2);

    const firstCallIds = extractBatch.mock.calls[0]?.[0].items.map((item) => item.itemId);
    const retryCallIds = extractBatch.mock.calls[1]?.[0].items.map((item) => item.itemId);
    expect(retryCallIds).toEqual(firstCallIds);

    const commitments = readCommitmentsForTest();
    expect(commitments.map((commitment) => commitment.dedupeKey).toSorted()).toEqual([
      "event:m1",
      "event:m2",
    ]);

    // A third drain has nothing left to do: no duplicate reprocessing.
    await expect(drainCommitmentExtractionQueue()).resolves.toBe(0);
    expect(extractBatch).toHaveBeenCalledTimes(2);
  });

  it("restores a failed batch to the front, preserving order across batches", async () => {
    const cfg = await createConfig();
    const seenOrder: string[] = [];
    let attempts = 0;
    const extractBatch = vi.fn(async ({ items }: { items: CommitmentExtractionItem[] }) => {
      attempts += 1;
      if (attempts === 1) {
        // Fail the first batch only; record nothing so order reflects success runs.
        throw new Error("transient extraction failure");
      }
      for (const item of items) {
        seenOrder.push(item.sourceMessageId ?? "");
      }
      return { candidates: [] };
    });
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      extractBatch,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    // Enqueue more than one batch (batchMaxItems = 8) so the restored batch must
    // land ahead of the tail rather than being appended.
    const total = 10;
    for (let index = 0; index < total; index += 1) {
      expect(
        enqueueCommitmentExtraction({
          cfg,
          nowMs: nowMs + index,
          agentId: "main",
          sessionKey: "agent:main:telegram:user-1",
          channel: "telegram",
          sourceMessageId: `m${index}`,
          userText: `Commitment candidate ${index}`,
          assistantText: "I will follow up.",
        }),
      ).toBe(true);
    }

    await expect(drainCommitmentExtractionQueue()).rejects.toThrow("transient extraction failure");
    await expect(drainCommitmentExtractionQueue()).resolves.toBe(total);

    const expectedOrder = Array.from({ length: total }, (_v, index) => `m${index}`);
    expect(seenOrder).toEqual(expectedOrder);
  });

  it("keeps the existing drop/stop behavior on terminal extraction failures", async () => {
    const cfg = await createConfig();
    const extractBatch = vi.fn(async () => {
      throw new Error('No API key found for provider "openai".');
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
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
        sourceMessageId: "m1",
        userText: "I have an interview tomorrow.",
        assistantText: "Good luck.",
      }),
    ).toBe(true);

    await expect(drainCommitmentExtractionQueue()).rejects.toThrow("No API key found");
    expect(extractBatch).toHaveBeenCalledTimes(1);

    // Terminal failures drop the agent's queued work; a retry must not reprocess
    // the dropped batch.
    await expect(drainCommitmentExtractionQueue()).resolves.toBe(0);
    expect(extractBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps other agents queued after a terminal extraction failure", async () => {
    const cfg = await createConfig();
    const scheduled: Array<() => void> = [];
    const extractBatch = vi.fn(async ({ items }: { items: CommitmentExtractionItem[] }) => {
      if (items[0]?.agentId === "alpha") {
        throw new Error('No API key found for provider "openai".');
      }
      return { candidates: [] };
    });
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      extractBatch,
      setTimer: (callback) => {
        scheduled.push(callback);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });

    for (const agentId of ["alpha", "beta"]) {
      expect(
        enqueueCommitmentExtraction({
          cfg,
          nowMs,
          agentId,
          sessionKey: `agent:${agentId}:telegram:user-1`,
          channel: "telegram",
          userText: "I have an interview tomorrow.",
          assistantText: "Good luck.",
        }),
      ).toBe(true);
    }

    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await vi.waitFor(() => {
      expect(extractBatch).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(scheduled).toHaveLength(2);
    });

    scheduled[1]?.();
    await vi.waitFor(() => {
      expect(extractBatch).toHaveBeenCalledTimes(2);
    });
    expect(extractBatch.mock.calls.map(([params]) => params.items[0]?.agentId)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("schedules a retry when a non-terminal failure leaves the queue full", async () => {
    const cfg = await createConfig();
    const scheduled: Array<() => void> = [];
    let attempts = 0;
    const extractBatch = vi.fn(
      async (_params: {
        items: CommitmentExtractionItem[];
      }): Promise<CommitmentExtractionBatchResult> => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient extraction failure");
        }
        return { candidates: [] };
      },
    );
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      extractBatch,
      setTimer: (callback) => {
        scheduled.push(callback);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
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
          sourceMessageId: `m${index}`,
          userText: `Commitment candidate ${index}`,
          assistantText: "I will follow up.",
        }),
      ).toBe(true);
    }
    // The single-slot debounce schedules exactly one drain while filling.
    expect(scheduled).toHaveLength(1);

    // Fire the scheduled drain: the first batch fails (non-terminal) and is
    // restored, leaving the queue full again with no pending timer.
    scheduled[0]?.();
    await vi.waitFor(() => {
      expect(extractBatch).toHaveBeenCalledTimes(1);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    // A new request is dropped because the queue is full, but the restored batch
    // must still get a retry scheduled, otherwise it would be stuck forever.
    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs: nowMs + DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
        agentId: "main",
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
        sourceMessageId: "overflow",
        userText: "Overflow candidate",
        assistantText: "I will follow up.",
      }),
    ).toBe(false);
    expect(scheduled).toHaveLength(2);

    // The drain is healthy after the failure: the full queue reprocesses cleanly.
    await expect(drainCommitmentExtractionQueue()).resolves.toBe(
      DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
    );
  });

  it("re-arms the drain after a timer-fired non-terminal failure with no later enqueue", async () => {
    const cfg = await createConfig();
    const scheduled: Array<() => void> = [];
    let attempts = 0;
    const extractBatch = vi.fn(async (params: { items: CommitmentExtractionItem[] }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient extraction failure");
      }
      return mapBatchToCandidates(params);
    });
    configureCommitmentExtractionRuntime({
      forceInTests: true,
      extractBatch,
      setTimer: (callback) => {
        scheduled.push(callback);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });

    expect(
      enqueueCommitmentExtraction({
        cfg,
        nowMs,
        agentId: "main",
        sessionKey: "agent:main:telegram:user-1",
        channel: "telegram",
        sourceMessageId: "m1",
        userText: "I have an interview tomorrow.",
        assistantText: "Good luck.",
      }),
    ).toBe(true);
    // The enqueue schedules exactly one drain via the single-slot debounce.
    expect(scheduled).toHaveLength(1);

    // Fire the scheduled drain. The timer callback clears the pending timer first,
    // then the extractor throws a non-terminal error and the batch is restored.
    scheduled[0]?.();
    await vi.waitFor(() => {
      expect(extractBatch).toHaveBeenCalledTimes(1);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    // Regression guard for the timer-fired-failure path: with no later enqueue to
    // reschedule it, the restored batch must still have a fresh drain armed, or it
    // would sit only in memory and be lost on process exit.
    expect(scheduled).toHaveLength(2);

    // Firing that re-armed drain reprocesses the same batch and persists it.
    scheduled[1]?.();
    await vi.waitFor(() => {
      expect(extractBatch).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(async () => {
      expect(readCommitmentsForTest().map((commitment) => commitment.dedupeKey)).toEqual([
        "event:m1",
      ]);
    });

    // The successful drain empties the queue, so no further retry is armed.
    expect(scheduled).toHaveLength(2);
  });
});
