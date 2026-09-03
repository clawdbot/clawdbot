import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveMemoryDreamingPluginConfig,
  resolveSessionTranscriptsDirForAgent,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

import { runDreamingSweepPhases } from "./dreaming-phases.js";
import { applyShortTermPromotions, type PromotionCandidate } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const DREAMING_NOW_MS = Date.parse("2026-08-03T19:00:00.000Z");
const PROMOTION_NOW_MS = Date.parse("2026-08-03T20:00:00.000Z");
const RAW_DREAMING_SECRET = "OPENAI_API_KEY=sk-1234567890abcdef"; // pragma: allowlist secret
const RAW_PROMOTION_SECRET = "OPENAI_API_KEY=sk-fedcba0987654321"; // pragma: allowlist secret

async function createWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await createTempWorkspace(prefix);
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  clearRuntimeConfigSnapshot();
  return workspaceDir;
}

async function seedInteractiveTranscript(params: {
  content: string;
  sessionId: string;
  timestamp: string;
}): Promise<void> {
  const agentId = "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${agentId}:chat:${params.sessionId}`;
  const entry = { sessionId: params.sessionId, updatedAt: Date.parse(params.timestamp) };
  await fs.mkdir(sessionsDir, { recursive: true });
  await upsertSessionEntry({ agentId, sessionKey, storePath, entry });
  await appendSessionTranscriptMessageByIdentity({
    agentId,
    sessionId: params.sessionId,
    sessionKey,
    storePath,
    message: {
      role: "user",
      content: [{ type: "text", text: params.content }],
      timestamp: params.timestamp,
      __openclaw: { senderIsOwner: true },
    },
  });
  await upsertSessionEntry({ agentId, sessionKey, storePath, entry });
}

function promotionCandidate(params: {
  key: string;
  line: number;
  originClass: "agent" | "owner" | "untrusted";
  path: string;
  snippet: string;
}): PromotionCandidate {
  return {
    key: params.key,
    path: params.path,
    startLine: params.line,
    endLine: params.line,
    source: "memory",
    snippet: params.snippet,
    recallCount: 3,
    signalCount: 3,
    avgScore: 0.95,
    maxScore: 0.95,
    uniqueQueries: 2,
    firstRecalledAt: "2026-08-01T18:00:00.000Z",
    lastRecalledAt: "2026-08-02T18:00:00.000Z",
    ageDays: 1,
    score: 0.95,
    recallDays: ["2026-08-01", "2026-08-02"],
    conceptTags: ["security", "boundary"],
    components: {
      frequency: 1,
      relevance: 0.95,
      diversity: 0.5,
      recency: 1,
      consolidation: 0.5,
      conceptual: 0.2,
    },
    provenance: {
      originClass: params.originClass,
      sessionKind: "interactive",
      observedAt: Date.parse("2026-08-02T18:00:00.000Z"),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

describe("memory-core redaction product boundaries", () => {
  it("redacts sensitive interactive transcript content before dreaming ingestion", async () => {
    const workspaceDir = await createWorkspace("redaction-dreaming-");
    const safeControlText = "Safe control text survives transcript ingestion.";
    await seedInteractiveTranscript({
      sessionId: "redaction-dreaming",
      timestamp: "2026-08-03T18:00:00.000Z",
      content: `${safeControlText} ${RAW_DREAMING_SECRET}`,
    });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: workspaceDir, userTimezone: "UTC" },
        list: [{ id: "main", workspace: workspaceDir }],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                timezone: "UTC",
                phases: {
                  light: { enabled: true, limit: 20, lookbackDays: 7 },
                  rem: { enabled: false, limit: 0, lookbackDays: 7 },
                },
              },
            },
          },
        },
      },
    };

    await expect(
      runDreamingSweepPhases({
        agentId: "main",
        workspaceDir,
        cfg,
        pluginConfig: resolveMemoryDreamingPluginConfig(cfg) ?? {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nowMs: DREAMING_NOW_MS,
      }),
    ).resolves.toEqual({ degradedPhases: 0, pendingNarratives: 0 });

    const corpus = await fs.readFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-08-03.txt"),
      "utf-8",
    );
    expect(corpus).toContain(safeControlText);
    expect(corpus).not.toContain(RAW_DREAMING_SECRET);
    expect(corpus).toContain("OPENAI_API_KEY=***");
  });

  it("promotes only clean trusted content across contamination and provenance gates", async () => {
    const workspaceDir = await createWorkspace("redaction-promotion-");
    const sourcePath = "memory/2026-08-03.md";
    const cleanKey = "clean-promotion-boundary";
    const contaminatedKey = "contaminated-promotion-boundary";
    const untrustedKey = "untrusted-promotion-boundary";
    const cleanText = "Keep the incident archive encrypted and access-controlled.";
    const contaminatedText = [
      `Candidate: CONTAMINATED_DREAMING_BOUNDARY ${RAW_PROMOTION_SECRET}`,
      "confidence: 0.99",
      "evidence: memory/.dreams/session-corpus/2026-08-03.txt:1-1",
      "recalls: 4",
      "status: staged",
    ].join(" ");
    const untrustedText = "UNTRUSTED_PROMOTION_BOUNDARY must never enter durable memory.";
    await fs.writeFile(
      path.join(workspaceDir, sourcePath),
      `${[cleanText, contaminatedText, untrustedText].join("\n")}\n`,
      "utf-8",
    );

    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates: [
        promotionCandidate({
          key: cleanKey,
          line: 1,
          originClass: "owner",
          path: sourcePath,
          snippet: cleanText,
        }),
        promotionCandidate({
          key: contaminatedKey,
          line: 2,
          originClass: "agent",
          path: sourcePath,
          snippet: contaminatedText,
        }),
        promotionCandidate({
          key: untrustedKey,
          line: 3,
          originClass: "untrusted",
          path: sourcePath,
          snippet: untrustedText,
        }),
      ],
      limit: 3,
      minScore: 0.9,
      minRecallCount: 3,
      minUniqueQueries: 2,
      maxAgeDays: 7,
      nowMs: PROMOTION_NOW_MS,
      timezone: "UTC",
    });

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates.map((candidate) => candidate.key)).toEqual([cleanKey]);

    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memory).toContain(cleanText);
    expect(memory).toContain(`<!-- openclaw-memory-promotion:${cleanKey} -->`);
    expect(memory).not.toContain(`openclaw-memory-promotion:${contaminatedKey}`);
    expect(memory).not.toContain("CONTAMINATED_DREAMING_BOUNDARY");
    expect(memory).not.toContain(`openclaw-memory-promotion:${untrustedKey}`);
    expect(memory).not.toContain(untrustedText);
    expect(memory).not.toContain(RAW_PROMOTION_SECRET);
    expect(memory).not.toContain("OPENAI_API_KEY=***");
  });
});
