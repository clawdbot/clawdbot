import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  configureCommitmentExtractionRuntime,
  drainCommitmentExtractionQueue,
  enqueueCommitmentExtraction,
  resetCommitmentExtractionRuntimeForTests,
} from "./runtime.js";
import { loadCommitmentStore } from "./store.js";
import type { CommitmentExtractionItem } from "./types.js";

describe("commitment extraction runtime", () => {
  const tmpDirs: string[] = [];
  const nowMs = Date.parse("2026-04-29T16:00:00.000Z");

  afterEach(async () => {
    resetCommitmentExtractionRuntimeForTests();
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
    const batchItems = extractBatch.mock.calls[0]?.[0].items;
    expect(batchItems).toHaveLength(2);
    expect(batchItems?.[0]?.itemId).not.toContain("main");
    expect(batchItems?.[0]?.itemId).not.toContain("telegram");
    expect(batchItems?.[0]?.itemId).not.toContain("15551234567");
    expect(batchItems?.[0]?.itemId).not.toContain("m1");
    expect(store.commitments.map((commitment) => commitment.dedupeKey)).toEqual([
      "event:1",
      "event:2",
    ]);
  });
});
