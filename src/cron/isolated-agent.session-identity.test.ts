// Isolated agent session identity tests cover stable session ids for cron runs.
import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelThinkingDefault from "../agents/model-thinking-default.js";
import { SessionManager } from "../agents/sessions/index.js";
import * as thinking from "../auto-reply/thinking.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
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
  readCronSessionEntry,
  runCronTurn,
  withTempHome,
} from "./isolated-agent.turn-test-helpers.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import { normalizeCronJobCreate } from "./normalize.js";
import type { CronJob, CronStoredJob } from "./types.js";

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
  patchSessionEntryMock.mockImplementation(sessionAccessor.patchSessionEntryCore);
}

function lastEmbeddedAgentCall(): {
  agentDir?: string;
  bootstrapContextMode?: "full" | "lightweight";
  prompt?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionTarget?: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    storePath?: string;
  };
  workspaceDir?: string;
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
    sessionTarget?: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
      storePath?: string;
    };
    workspaceDir?: string;
  };
}

function mockEmbeddedTranscriptWrite(
  storePath: string,
  content: string,
  resultMeta?: {
    sessionId?: string;
    sessionFile?: string;
    compactionCount?: number;
    compactionTokensAfter?: number;
  },
): void {
  runEmbeddedAgentMock.mockImplementationOnce(async (input: Record<string, unknown>) => {
    const agentId = typeof input.agentId === "string" ? input.agentId : "main";
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey : "";
    const workspaceDir =
      typeof input.workspaceDir === "string" ? input.workspaceDir : process.cwd();
    const manager = SessionManager.open(
      { agentId, sessionId, sessionKey, storePath },
      workspaceDir,
    );
    manager.appendMessage({ role: "user", content, timestamp: Date.now() });
    return {
      payloads: [{ text: "ok" }],
      meta: {
        durationMs: 5,
        agentMeta: {
          sessionId: resultMeta?.sessionId ?? sessionId,
          ...(resultMeta?.sessionFile ? { sessionFile: resultMeta.sessionFile } : {}),
          provider: "anthropic",
          model: "claude-opus-4-6",
          ...(resultMeta?.compactionCount !== undefined
            ? { compactionCount: resultMeta.compactionCount }
            : {}),
          ...(resultMeta?.compactionTokensAfter !== undefined
            ? { compactionTokensAfter: resultMeta.compactionTokensAfter }
            : {}),
        },
      },
    };
  });
}

describe("runCronIsolatedAgentTurn session identity", () => {
  beforeEach(() => {
    vi.spyOn(modelThinkingDefault, "resolveThinkingDefault").mockReturnValue("off");
    vi.spyOn(thinking, "isThinkingLevelSupported").mockReturnValue(true);
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

  it.each([
    {
      label: "uses agentId for workspace, session key, and store paths",
      agentId: "ops",
      sessionKey: "cron:job-ops",
      explicitAgentId: true,
      jobSessionKey: false,
    },
    {
      label: "uses an agent-scoped job session when the cron job omits agentId",
      agentId: "molty",
      sessionKey: "agent:molty:cron:job-molty",
      explicitAgentId: false,
      jobSessionKey: true,
    },
  ])("$label", async ({ agentId, sessionKey, explicitAgentId, jobSessionKey }) => {
    await withTempHome(async (home) => {
      const deps = makeDeps();
      const workspaceDir = path.join(home, `${agentId}-workspace`);
      mockEmbeddedOk();

      const cfg = makeCfg(
        home,
        path.join(home, ".openclaw", "agents", "{agentId}", "sessions", "sessions.json"),
        {
          agents: {
            defaults: { workspace: path.join(home, "default-workspace") },
            list: [{ id: "main" }, { id: agentId, workspace: workspaceDir }],
          },
        },
      );

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: DEFAULT_MESSAGE }),
          ...(explicitAgentId ? { agentId } : {}),
          ...(jobSessionKey ? { sessionKey } : {}),
          delivery: { mode: "none" },
        },
        message: DEFAULT_MESSAGE,
        sessionKey,
        ...(explicitAgentId ? { agentId } : {}),
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = lastEmbeddedAgentCall();
      expect(call.sessionKey).toMatch(new RegExp(`^agent:${agentId}:`));
      expect(call.workspaceDir).toBe(workspaceDir);
      expect(call.sessionTarget).toEqual({
        agentId,
        sessionId: call.sessionId,
        sessionKey: call.sessionKey,
        storePath: path.join(home, ".openclaw", "agents", agentId, "sessions", "sessions.json"),
      });
    });
  });

  it("passes the canonical identity through the structured session target", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });
      const call = lastEmbeddedAgentCall();

      expect(call.sessionTarget).toEqual({
        agentId: "main",
        sessionId: call.sessionId,
        sessionKey: call.sessionKey,
        storePath: expect.any(String),
      });
    });
  });

  it.each([
    ["cron", "cron:job-1"],
    ["hook", "hook:webhook:request-1"],
  ])("initializes the exact %s run session before transcript writes", async (_name, sessionKey) => {
    await useRealCronSessionState();
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      mockEmbeddedTranscriptWrite(storePath, `${sessionKey} transcript`);

      const { res } = await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: "persist this turn",
          ...(sessionKey.startsWith("hook:") ? { externalContentSource: "webhook" as const } : {}),
        },
        message: "persist this turn",
        mockTexts: null,
        sessionKey,
        storePath,
      });

      expect(res.status, res.status === "error" ? res.error : undefined).toBe("ok");
      expect(res.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
    });
  });

  it.each([false, true])(
    "stamps both cron owners before running the authenticated creator's work (%s)",
    async (required) => {
      await useRealCronSessionState();
      await withTempHome(async (home) => {
        const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
        const profile = ensureProfileForEmail("cron-creator@example.test");
        const createdActor = { type: "human" as const, id: profile.id };
        const job: CronStoredJob = {
          ...makeJob({ kind: "agentTurn", message: "persist this turn" }),
          createdActor,
          delivery: { mode: "none" },
        };
        const cfg = makeCfg(
          home,
          storePath,
          required
            ? {
                gateway: {
                  roles: {
                    default: "guest",
                    definitions: {
                      guest: {
                        sessions: { others: "none" },
                        agents: "*",
                        scopes: [],
                        sandbox: "required",
                      },
                    },
                  },
                },
              }
            : {},
        );
        runEmbeddedAgentMock.mockImplementationOnce(async (input: Record<string, unknown>) => {
          const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey : "";
          expect(sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
          for (const key of ["agent:main:cron:job-1", sessionKey]) {
            const entry = loadSessionEntry({ storePath, sessionKey: key });
            expect(entry).toMatchObject({ createdVia: "cron", createdActor });
            expect(entry?.sandbox).toBe(required ? "required" : undefined);
          }
          return {
            payloads: [{ text: "ok" }],
            meta: {
              durationMs: 5,
              agentMeta: {
                sessionId: input.sessionId,
                provider: "anthropic",
                model: "claude-opus-4-6",
              },
            },
          };
        });
        const res = await runCronIsolatedAgentTurn({
          cfg,
          deps: makeDeps(),
          job,
          message: "persist this turn",
          sessionKey: "cron:job-1",
          lane: "cron",
        });
        expect(res.status, res.status === "error" ? res.error : undefined).toBe("ok");
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        for (const key of ["agent:main:cron:job-1", res.sessionKey!]) {
          const entry = await readCronSessionEntry(storePath, key);
          expect(entry).toMatchObject({ createdActor });
          expect(entry?.sandbox).toBe(required ? "required" : undefined);
        }
      });
    },
  );

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
      const currentBoundJob = normalizeCronJobCreate(
        {
          ...makeJob(DEFAULT_AGENT_TURN_PAYLOAD),
          sessionTarget: "current",
          delivery: { mode: "none" },
        },
        { sessionContext: { sessionKey: boundSessionKey } },
      ) as CronJob;
      const executionSessionKey = `agent:main:cron:${currentBoundJob.id}`;
      mockEmbeddedTranscriptWrite(storePath, "current-bound transcript", {
        sessionId: "bound-session-rotated",
        sessionFile: rotatedSessionFile,
        compactionCount: 1,
        compactionTokensAfter: 42,
      });

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

      await expect(readCronSessionEntry(storePath, executionSessionKey)).resolves.toEqual(
        expect.objectContaining({
          sessionId: "bound-session-rotated",
        }),
      );
      await expect(readCronSessionEntry(storePath, boundSessionKey)).resolves.toEqual(
        expect.objectContaining({
          sessionId: "bound-session",
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
      await upsertSessionEntryCore(
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
      const entry = await readCronSessionEntry(storePath, "agent:main:cron:job-1");

      expect(entry?.label).toBe("Nightly digest");
    });
  });
});
