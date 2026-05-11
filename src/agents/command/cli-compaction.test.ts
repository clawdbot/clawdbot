import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  resetCliCompactionTestDeps,
  runCliTurnCompactionLifecycle,
  setCliCompactionTestDeps,
} from "./cli-compaction.js";

function buildContextEngine(params: {
  compactCalls: Array<Parameters<ContextEngine["compact"]>[0]>;
}): ContextEngine {
  return {
    info: {
      id: "legacy",
      name: "Legacy Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(assembleParams) {
      return { messages: assembleParams.messages, estimatedTokens: 0 };
    },
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
        },
      };
    },
  };
}

async function writeSessionFile(params: { sessionFile: string; sessionId: string }) {
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  await fs.writeFile(
    params.sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: path.dirname(params.sessionFile),
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "old ask", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          timestamp: 2,
        },
      }),
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("runCliTurnCompactionLifecycle", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-"));
  });

  afterEach(async () => {
    resetCliCompactionTestDeps();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("compacts over-budget CLI transcripts and clears external CLI resume state", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli";
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const storePath = path.join(tmpDir, "sessions.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
      },
      cliSessionIds: {
        "claude-cli": "claude-session",
      },
      claudeCliSessionId: "claude-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: maintenance,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    expect(compactCalls).toHaveLength(1);
    const compactCall = compactCalls[0];
    expect(compactCall?.sessionId).toBe(sessionId);
    expect(compactCall?.sessionKey).toBe(sessionKey);
    expect(compactCall?.sessionFile).toBe(sessionFile);
    expect(compactCall?.tokenBudget).toBe(1_000);
    expect(compactCall?.currentTokenCount).toBe(950);
    expect(compactCall?.force).toBe(true);
    expect(compactCall?.compactionTarget).toBe("budget");
    expect(maintenance).toHaveBeenCalledTimes(1);
    const maintenanceCalls = maintenance.mock.calls as unknown as Array<
      [
        {
          reason?: string;
          sessionId?: string;
          sessionKey?: string;
          sessionFile?: string;
        },
      ]
    >;
    const maintenanceCall = maintenanceCalls[0]?.[0];
    expect(maintenanceCall?.reason).toBe("compaction");
    expect(maintenanceCall?.sessionId).toBe(sessionId);
    expect(maintenanceCall?.sessionKey).toBe(sessionKey);
    expect(maintenanceCall?.sessionFile).toBe(sessionFile);
    expect(updatedEntry?.compactionCount).toBe(1);
    expect(updatedEntry?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("initializes built-in context engines before resolving CLI compaction engine", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli-init";
    const sessionFile = path.join(tmpDir, "session-init.jsonl");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 100,
      totalTokensFresh: true,
    };
    const calls: string[] = [];
    setCliCompactionTestDeps({
      ensureContextEnginesInitialized: () => {
        calls.push("ensure");
      },
      resolveContextEngine: async () => {
        calls.push("resolve");
        return buildContextEngine({ compactCalls: [] });
      },
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 100,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
    });

    await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    expect(calls).toEqual(["ensure", "resolve"]);
  });
});
