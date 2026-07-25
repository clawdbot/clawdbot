// Isolated agent session identity tests cover stable session ids for cron runs.
import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as modelThinkingDefault from "../agents/model-thinking-default.js";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  writeSessionStore,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import {
  DEFAULT_AGENT_TURN_PAYLOAD,
  DEFAULT_MESSAGE,
  makeDeps,
  mockEmbeddedOk,
  readSessionEntry,
  runCronTurn,
  withTempHome,
} from "./isolated-agent.turn-test-helpers.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  loadSessionEntryMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import { normalizeCronJobCreate } from "./normalize.js";
import type { CronJob } from "./types.js";

setupRunCronIsolatedAgentTurnSuite();

async function useRealCronSessionState(): Promise<void> {
  const [sessionRuntime, sessionAccessor] = await Promise.all([
    vi.importActual<typeof import("./isolated-agent/session.js")>("./isolated-agent/session.js"),
    vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
      "../config/sessions/session-accessor.js",
    ),
  ]);
  resolveCronSessionMock.mockImplementation(sessionRuntime.resolveCronSession);
  loadSessionEntryMock.mockImplementation(sessionRuntime.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(sessionAccessor.patchSessionEntry);
}

function lastEmbeddedAgentCall(): {
  agentDir?: string;
  bootstrapContextMode?: "full" | "lightweight";
  prompt?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  sessionFile?: string;
} {
  const calls = runEmbeddedAgentMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected runEmbeddedAgent call");
  }
  const value = call[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected runEmbeddedAgent call payload");
  }
  return value as {
    agentDir?: string;
    bootstrapContextMode?: "full" | "lightweight";
    prompt?: string;
    sessionId?: string;
    sessionKey?: string;
    workspaceDir?: string;
    sessionFile?: string;
  };
}

describe("runCronIsolatedAgentTurn session identity", () => {
  beforeAll(async () => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
    vi.spyOn(modelThinkingDefault, "resolveThinkingDefault").mockReturnValue("off");
    mockRunCronFallbackPassthrough();
    await withTempHome(async (home) => {
      await runCronTurn(home, { jobPayload: DEFAULT_AGENT_TURN_PAYLOAD });
    });
  });

  beforeEach(() => {
    vi.spyOn(modelThinkingDefault, "resolveThinkingDefault").mockReturnValue("off");
    runEmbeddedAgentMock.mockClear();
    mockRunCronFallbackPassthrough();
  });

  it("passes resolved agentDir to runEmbeddedAgent", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });

      expect(res.status).toBe("ok");
      const call = lastEmbeddedAgentCall();
      expect(call.agentDir).toBe(path.join(home, ".openclaw", "agents", "main", "agent"));
    });
  });

  it("appends current time after the cron header line", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });

      const call = lastEmbeddedAgentCall();
      const lines = (call.prompt ?? "").split("\n");
      expect(lines[0]).toContain("[cron:job-1");
      expect(lines[0]).toContain("do it");
      expect(lines[1]).toMatch(/^Current time: .+ \(.+\)$/);
      expect(lines[2]).toMatch(/^Reference UTC: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    });
  });

  it("uses agentId for workspace, session key, and store paths", async () => {
    await withTempHome(async (home) => {
      const deps = makeDeps();
      const opsWorkspace = path.join(home, "ops-workspace");
      mockEmbeddedOk();

      const cfg = makeCfg(
        home,
        path.join(home, ".openclaw", "agents", "{agentId}", "sessions", "sessions.json"),
        {
          agents: {
            defaults: { workspace: path.join(home, "default-workspace") },
            list: [
              { id: "main", default: true },
              { id: "ops", workspace: opsWorkspace },
            ],
          },
        },
      );

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
          }),
          agentId: "ops",
          delivery: { mode: "none" },
        },
        message: DEFAULT_MESSAGE,
        sessionKey: "cron:job-ops",
        agentId: "ops",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = lastEmbeddedAgentCall();
      expect(call.sessionKey).toMatch(/^agent:ops:cron:job-ops:run:/);
      expect(call.workspaceDir).toBe(opsWorkspace);
      expect(call.sessionFile).toContain(path.join("agents", "ops"));
    });
  });

  it("passes sessionFile to isolated cron runs", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });
      const call = lastEmbeddedAgentCall();

      expect(call.sessionFile).toBe(
        `sqlite:main:${call.sessionId}:${path.join(
          home,
          ".openclaw",
          "sessions",
          "sessions.json",
        )}`,
      );
    });
  });

  it("persists rotated transcript identity for current-bound cron runs", async () => {
    await withTempHome(async (home) => {
      const deps = makeDeps();
      const boundSessionKey = "agent:main:telegram:direct:42";
      const originalSessionFile = path.join(home, "bound-session.jsonl");
      const rotatedSessionFile = path.join(home, "bound-session-rotated.jsonl");
      await fs.writeFile(rotatedSessionFile, "");
      const storePath = await writeSessionStoreEntries(home, {
        [boundSessionKey]: {
          sessionId: "bound-session",
          sessionFile: originalSessionFile,
          updatedAt: Date.now(),
          lastInteractionAt: Date.now() - 1_000,
          systemSent: true,
        },
      });
      runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: {
            sessionId: "bound-session-rotated",
            sessionFile: rotatedSessionFile,
            provider: "anthropic",
            model: "claude-opus-4-6",
            compactionCount: 1,
            compactionTokensAfter: 42,
          },
        },
      });
      const currentBoundJob = normalizeCronJobCreate(
        {
          ...makeJob(DEFAULT_AGENT_TURN_PAYLOAD),
          sessionTarget: "current",
          delivery: { mode: "none" },
        },
        { sessionContext: { sessionKey: boundSessionKey } },
      ) as CronJob;
      const executionSessionKey = `agent:main:cron:${currentBoundJob.id}`;

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: currentBoundJob,
        message: DEFAULT_MESSAGE,
        sessionKey: boundSessionKey,
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.sessionId).toBe("bound-session-rotated");
      expect(dispatchCronDeliveryMock.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ sessionId: "bound-session-rotated" }),
      );

      await expect(readSessionEntry(storePath, executionSessionKey)).resolves.toEqual(
        expect.objectContaining({
          sessionId: "bound-session-rotated",
          sessionFile: rotatedSessionFile,
        }),
      );
      await expect(readSessionEntry(storePath, boundSessionKey)).resolves.toEqual(
        expect.objectContaining({
          sessionId: "bound-session",
          sessionFile: originalSessionFile,
        }),
      );
    });
  });

  it("uses lightweight bootstrap context for command-style cron payloads", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: "cd /srv/openclaw && ./scripts/nightly-report.sh",
        },
      });

      expect(lastEmbeddedAgentCall().bootstrapContextMode).toBe("lightweight");
    });
  });

  it("does not force lightweight bootstrap context for natural-language cron payloads", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: "Prepare the nightly status summary" },
      });

      expect(lastEmbeddedAgentCall().bootstrapContextMode).toBeUndefined();
    });
  });

  it("honors explicit full bootstrap context for command-style cron payloads", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: "pnpm run nightly-report",
          lightContext: false,
        },
      });

      expect(lastEmbeddedAgentCall().bootstrapContextMode).toBeUndefined();
    });
  });

  it("starts a fresh session id for each cron run", async () => {
    await useRealCronSessionState();
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = makeDeps();
      const runPingTurn = () =>
        runCronTurn(home, {
          deps,
          jobPayload: { kind: "agentTurn", message: "ping" },
          message: "ping",
          mockTexts: ["ok"],
          storePath,
        });

      const first = (await runPingTurn()).res;
      const second = (await runPingTurn()).res;

      expect(first.sessionId).toBeTypeOf("string");
      expect(second.sessionId).toBeTypeOf("string");
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(first.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
      expect(second.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
      expect(second.sessionKey).not.toBe(first.sessionKey);
    });
  });

  it("preserves an existing cron session label", async () => {
    await useRealCronSessionState();
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      await upsertSessionEntry(
        { storePath, sessionKey: "agent:main:cron:job-1" },
        {
          sessionId: "old",
          updatedAt: Date.now(),
          label: "Nightly digest",
        },
      );

      await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: "ping" },
        message: "ping",
        storePath,
      });
      const entry = await readSessionEntry(storePath, "agent:main:cron:job-1");

      expect(entry?.label).toBe("Nightly digest");
    });
  });
});
