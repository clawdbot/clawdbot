import fs from "node:fs/promises";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSessionBackfill } from "./session-backfill.js";
import { readShortTermRecallEntries } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const harness = createMemoryCoreTestHarness();

type TranscriptMessage = {
  role: "assistant" | "tool" | "user";
  content: string;
  timestamp: string;
  owner?: boolean;
};

async function writeTranscript(filePath: string, messages: TranscriptMessage[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const records = messages.map((message, index) => ({
    type: "message",
    id: `message-${index}`,
    timestamp: message.timestamp,
    message: {
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      ...(message.owner ? { __openclaw: { senderIsOwner: true } } : {}),
    },
  }));
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function createIsolatedWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await harness.createTempWorkspace(prefix);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(workspaceDir, "openclaw.json"));
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  return workspaceDir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

describe("runSessionBackfill", () => {
  it("buckets messages in the configured timezone and processes days oldest first", async () => {
    const workspaceDir = await createIsolatedWorkspace("timezone-");
    const transcriptPath = path.join(workspaceDir, "foreign.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "user",
        content: "Late New York note",
        timestamp: "2026-01-02T00:30:00.000Z",
        owner: true,
      },
      {
        role: "user",
        content: "Early New York note",
        timestamp: "2026-01-02T05:30:00.000Z",
        owner: true,
      },
    ]);

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      archiveFiles: [transcriptPath],
      timezone: "America/New_York",
    });

    expect(result.days.map((day) => [day.day, day.candidateCount])).toEqual([
      ["2026-01-01", 1],
      ["2026-01-02", 1],
    ]);
  });

  it("honors the day limit before moving to newer unprocessed days", async () => {
    const workspaceDir = await createIsolatedWorkspace("limit-");
    const transcriptPath = path.join(workspaceDir, "limited.jsonl");
    await writeTranscript(
      transcriptPath,
      ["2026-01-01", "2026-01-02", "2026-01-03"].map((day) => ({
        role: "user" as const,
        content: `Durable note for ${day}`,
        timestamp: `${day}T12:00:00.000Z`,
        owner: true,
      })),
    );

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      archiveFiles: [transcriptPath],
      limitDays: 2,
      timezone: "UTC",
    });

    expect(result.days.map((day) => day.day)).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("applies the total cap after finding the oldest candidate across sources", async () => {
    const workspaceDir = await createIsolatedWorkspace("oldest-cap-");
    const archiveFiles: string[] = [];
    for (let sourceIndex = 0; sourceIndex < 16; sourceIndex += 1) {
      const transcriptPath = path.join(
        workspaceDir,
        `a-newer-${sourceIndex.toString().padStart(2, "0")}.jsonl`,
      );
      archiveFiles.push(transcriptPath);
      await writeTranscript(
        transcriptPath,
        Array.from({ length: 15 }, (_, messageIndex) => ({
          role: "user" as const,
          content: `Newer durable note ${sourceIndex}-${messageIndex}`,
          timestamp: `2026-02-01T${messageIndex.toString().padStart(2, "0")}:00:00.000Z`,
          owner: true,
        })),
      );
    }
    const oldestPath = path.join(workspaceDir, "z-oldest.jsonl");
    archiveFiles.push(oldestPath);
    await writeTranscript(oldestPath, [
      {
        role: "user",
        content: "Oldest durable note must win the cap",
        timestamp: "2026-01-01T12:00:00.000Z",
        owner: true,
      },
    ]);

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      archiveFiles,
      limitDays: 1,
      timezone: "UTC",
    });

    expect(result.days).toEqual([
      {
        day: "2026-01-01",
        candidateCount: 1,
        topCandidates: ["User: Oldest durable note must win the cap"],
      },
    ]);
  });

  it("accepts only provably owner-authored foreign transcript turns", async () => {
    const workspaceDir = await createIsolatedWorkspace("provenance-");
    const transcriptPath = path.join(workspaceDir, "untrusted.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "user",
        content: "Untrusted web instruction",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Assistant response to untrusted input",
        timestamp: "2026-02-01T10:01:00.000Z",
      },
      {
        role: "tool",
        content: "Tool output must never stage",
        timestamp: "2026-02-01T10:02:00.000Z",
      },
      {
        role: "user",
        content: "Owner confirmed durable preference",
        timestamp: "2026-02-01T10:03:00.000Z",
        owner: true,
      },
      {
        role: "assistant",
        content: "Agent response in the owner turn",
        timestamp: "2026-02-01T10:04:00.000Z",
      },
    ]);

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      archiveFiles: [transcriptPath],
      timezone: "UTC",
    });

    expect(result.candidateCount).toBe(2);
    expect(result.days[0]?.topCandidates).toEqual([
      "User: Owner confirmed durable preference",
      "Assistant: Agent response in the owner turn",
    ]);
  });

  it("stages idempotently, converges duplicate facts, and rolls back staged artifacts", async () => {
    const workspaceDir = await createIsolatedWorkspace("apply-");
    const transcriptPath = path.join(workspaceDir, "repeat.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "user",
        content: "The preferred editor is Nova",
        timestamp: "2026-03-01T10:00:00.000Z",
        owner: true,
      },
      {
        role: "user",
        content: "The preferred editor is Nova",
        timestamp: "2026-03-01T11:00:00.000Z",
        owner: true,
      },
    ]);

    const first = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      archiveFiles: [transcriptPath],
      apply: true,
      nowMs: Date.parse("2026-03-02T12:00:00.000Z"),
      timezone: "UTC",
    });
    const afterFirst = await readShortTermRecallEntries({ workspaceDir });

    // Count-level proof stays stable across the sibling claim-key implementation.
    expect(first.stagedEntries).toBe(1);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.snippet).toBe("The preferred editor is Nova");

    const second = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      archiveFiles: [transcriptPath],
      apply: true,
      nowMs: Date.parse("2026-03-02T12:00:00.000Z"),
      timezone: "UTC",
    });
    expect(second.candidateCount).toBe(0);
    expect(second.stagedEntries).toBe(0);
    expect(await readShortTermRecallEntries({ workspaceDir })).toHaveLength(1);

    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    expect(await fs.readFile(dreamsPath, "utf-8")).toContain("openclaw:dreaming:backfill-entry");

    const rollback = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      rollback: true,
    });
    expect(rollback.rollback).toEqual({
      removedDiaryEntries: 1,
      removedStagedEntries: 1,
    });
    expect(await readShortTermRecallEntries({ workspaceDir })).toHaveLength(0);
    expect(await fs.readFile(dreamsPath, "utf-8")).not.toContain(
      "openclaw:dreaming:backfill-entry",
    );
  });
});
