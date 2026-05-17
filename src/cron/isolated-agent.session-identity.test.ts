import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelThinkingDefault from "../agents/model-thinking-default.js";
import type { SessionEntry } from "../config/sessions.js";
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
  mockRunCronFallbackPassthrough,
  runEmbeddedPiAgentMock,
  updateSessionStoreMock,
} from "./isolated-agent/run.test-harness.js";
import { normalizeCronJobCreate } from "./normalize.js";
import type { CronJob } from "./types.js";

setupRunCronIsolatedAgentTurnSuite();

function lastEmbeddedAgentCall(): {
  agentDir?: string;
  bootstrapContextMode?: "full" | "lightweight";
  prompt?: string;
  sessionKey?: string;
  workspaceDir?: string;
  sessionFile?: string;
} {
  const calls = runEmbeddedPiAgentMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected runEmbeddedPiAgent call");
  }
  const value = call[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected runEmbeddedPiAgent call payload");
  }
  return value as {
    agentDir?: string;
    bootstrapContextMode?: "full" | "lightweight";
    prompt?: string;
    sessionKey?: string;
    workspaceDir?: string;
    sessionFile?: string;
  };
}

describe("runCronIsolatedAgentTurn session identity", () => {
  beforeEach(() => {
    vi.spyOn(modelThinkingDefault, "resolveThinkingDefault").mockReturnValue("off");
    runEmbeddedPiAgentMock.mockClear();
    mockRunCronFallbackPassthrough();
  });

  it("passes resolved agentDir to runEmbeddedPiAgent", async () => {
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

      expect(call.sessionFile).toContain(
        path.join(home, ".openclaw", "agents", "main", "sessions"),
      );
      expect(String(call.sessionFile).endsWith(".jsonl")).toBe(true);
    });
  });

  it("persists rotated transcript identity for current-bound cron runs", async () => {
    await withTempHome(async (home) => {
      const deps = makeDeps();
      const boundSessionKey = "agent:main:telegram:direct:42";
      const originalSessionFile = path.join(home, "bound-session.jsonl");
      const rotatedSessionFile = path.join(home, "bound-session-rotated.jsonl");
      const storePath = await writeSessionStoreEntries(home, {
        [boundSessionKey]: {
          sessionId: "bound-session",
          sessionFile: originalSessionFile,
          updatedAt: Date.now(),
          lastInteractionAt: Date.now() - 1_000,
          systemSent: true,
        },
      });
      runEmbeddedPiAgentMock.mockResolvedValueOnce({
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
      updateSessionStoreMock.mockImplementation(async (targetStorePath, update) => {
        const raw = await fs.readFile(targetStorePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, SessionEntry>;
        update(store);
        await fs.writeFile(targetStorePath, JSON.stringify(store, null, 2), "utf-8");
      });
      const currentBoundJob = normalizeCronJobCreate(
        {
          ...makeJob(DEFAULT_AGENT_TURN_PAYLOAD),
          sessionTarget: "current",
          delivery: { mode: "none" },
        },
        { sessionContext: { sessionKey: boundSessionKey } },
      ) as CronJob;

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

      const finalPersist = updateSessionStoreMock.mock.calls.at(-1);
      expect(finalPersist?.[0]).toBe(storePath);
      const persistedStore: Record<string, { [key: string]: unknown }> = {};
      (finalPersist?.[1] as (store: typeof persistedStore) => void)(persistedStore);
      expect(persistedStore[boundSessionKey]).toEqual(
        expect.objectContaining({
          sessionId: "bound-session-rotated",
          sessionFile: rotatedSessionFile,
          usageFamilyKey: boundSessionKey,
          usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
        }),
      );

      await expect(readSessionEntry(storePath, boundSessionKey)).resolves.toEqual(
        expect.objectContaining({
          sessionId: "bound-session-rotated",
          sessionFile: rotatedSessionFile,
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
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const raw = await fs.readFile(storePath, "utf-8");
      const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      store["agent:main:cron:job-1"] = {
        sessionId: "old",
        updatedAt: Date.now(),
        label: "Nightly digest",
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

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
