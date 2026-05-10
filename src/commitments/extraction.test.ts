import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildCommitmentExtractionPrompt,
  parseCommitmentExtractionOutput,
  persistCommitmentExtractionResult,
  validateCommitmentCandidates,
} from "./extraction.js";
import { loadCommitmentStore } from "./store.js";
import type { CommitmentCandidate, CommitmentExtractionItem } from "./types.js";

describe("commitment extraction", () => {
  const tmpDirs: string[] = [];
  const nowMs = Date.parse("2026-04-29T16:00:00.000Z");

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function createConfig(): Promise<OpenClawConfig> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commitments-"));
    tmpDirs.push(tmpDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    return {
      commitments: {
        enabled: true,
      },
    };
  }

  function item(overrides?: Partial<CommitmentExtractionItem>): CommitmentExtractionItem {
    return {
      itemId: "turn-1",
      nowMs,
      timezone: "America/Los_Angeles",
      agentId: "main",
      sessionKey: "agent:main:telegram:user-1",
      channel: "telegram",
      to: "15551234567",
      userText: "I have an interview tomorrow.",
      assistantText: "Good luck. I hope it goes well.",
      existingPending: [],
      ...overrides,
    };
  }

  function candidate(overrides?: Partial<CommitmentCandidate>): CommitmentCandidate {
    return {
      itemId: "turn-1",
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      reason: "The user said they had an interview tomorrow.",
      suggestedText: "How did the interview go?",
      dedupeKey: "interview:2026-04-30",
      confidence: 0.91,
      dueWindow: {
        earliest: "2026-04-30T17:00:00.000Z",
        latest: "2026-04-30T23:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      ...overrides,
    };
  }

  function expectSingleValidCandidate(
    valid: ReturnType<typeof validateCommitmentCandidates>,
  ): ReturnType<typeof validateCommitmentCandidates>[number] {
    expect(valid).toHaveLength(1);
    const [entry] = valid;
    if (!entry) {
      throw new Error("Expected one valid commitment candidate");
    }
    return entry;
  }

  it("parses valid candidates from JSON output with surrounding text", () => {
    const parsed = parseCommitmentExtractionOutput(
      `noise {"candidates":[${JSON.stringify(candidate())}]} trailing`,
    );

    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.kind).toBe("event_check_in");
    expect(parsed.candidates[0]?.suggestedText).toBe("How did the interview go?");
  });

  it("omits routing scope identifiers from extractor prompts", () => {
    const prompt = buildCommitmentExtractionPrompt({
      items: [
        item({
          itemId: "public-item-1",
          agentId: "agent-secret",
          sessionKey: "session-secret",
          channel: "channel-secret",
          accountId: "account-secret",
          to: "+15551234567",
          threadId: "thread-secret",
        }),
      ],
    });

    expect(prompt).toContain("public-item-1");
    expect(prompt).not.toContain("agent-secret");
    expect(prompt).not.toContain("session-secret");
    expect(prompt).not.toContain("channel-secret");
    expect(prompt).not.toContain("account-secret");
    expect(prompt).not.toContain("+15551234567");
    expect(prompt).not.toContain("thread-secret");
  });

  it("rejects disabled, low-confidence, and non-future candidates", () => {
    const cfg: OpenClawConfig = { commitments: { enabled: true } };
    const valid = validateCommitmentCandidates({
      cfg,
      items: [item()],
      result: {
        candidates: [
          candidate(),
          candidate({ dedupeKey: "low-confidence", confidence: 0.5 }),
          candidate({
            dedupeKey: "past",
            dueWindow: { earliest: "2026-04-29T15:00:00.000Z" },
          }),
        ],
      },
    });

    expect(valid.map((entry) => entry.candidate.dedupeKey)).toEqual(["interview:2026-04-30"]);
  });

  it("clamps inferred due time to at least one heartbeat interval after write time", () => {
    const writeMs = nowMs + 5_000;
    const valid = validateCommitmentCandidates({
      cfg: {
        agents: {
          defaults: {
            heartbeat: { every: "10m" },
          },
        },
      },
      items: [item()],
      result: {
        candidates: [
          candidate({
            dedupeKey: "too-soon",
            dueWindow: {
              earliest: new Date(nowMs + 60_000).toISOString(),
              latest: new Date(nowMs + 120_000).toISOString(),
            },
          }),
        ],
      },
      nowMs: writeMs,
    });

    const validCandidate = expectSingleValidCandidate(valid);
    expect(validCandidate.earliestMs).toBe(writeMs + 10 * 60_000);
    expect(validCandidate.latestMs).toBe(writeMs + 10 * 60_000 + 12 * 60 * 60_000);
  });

  it("persists inferred commitments and dedupes by scope and dedupe key", async () => {
    const cfg = await createConfig();
    const created = await persistCommitmentExtractionResult({
      cfg,
      items: [item()],
      result: { candidates: [candidate()] },
      nowMs,
    });
    const deduped = await persistCommitmentExtractionResult({
      cfg,
      items: [item()],
      result: {
        candidates: [
          candidate({
            reason: "Updated reason",
            confidence: 0.97,
            dueWindow: { earliest: "2026-04-30T18:00:00.000Z" },
          }),
        ],
      },
      nowMs: nowMs + 1_000,
    });
    const store = await loadCommitmentStore();

    expect(created).toHaveLength(1);
    expect(deduped).toHaveLength(0);
    expect(store.commitments).toHaveLength(1);
    expect(store.commitments[0]?.reason).toBe("Updated reason");
    expect(store.commitments[0]?.confidence).toBe(0.97);
    expect(store.commitments[0]?.status).toBe("pending");
  });
});
